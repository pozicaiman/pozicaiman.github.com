---
title: Kubernetes 排障实战系列（二）：网络 - CNI / DNS / 连通性
date: 2026-10-08 21:00:00
categories: [Kubernetes]
tags: [Kubernetes, 排障, CNI, CoreDNS, NetworkPolicy, kube-proxy, 网络]
---

# 第 1 章：K8s 网络模型 - 排障前必须建立的地图

## 1.1 Kubernetes 网络模型的四条铁律

K8s 本身不实现网络，它只定义了一套**网络模型规范**，由 CNI 插件去落地。这四条规则决定了"什么应该通"，是判断"异常"的基准线：

1. 每个 Pod 拥有独立 IP，集群内**任意 Pod 之间可以直接通信**，无需 NAT。
2. **节点上的代理（kubelet / DaemonSet Pod）可以与该节点上所有 Pod 通信**。
3. 集群内部（Pod → Service → Pod）**不使用 NAT**；NAT 只出现在 Service 这一层的目的地址替换。
4. 同一 Pod 内的容器共享网络命名空间，通过 `localhost` 通信。

> 关键认知：只要"Pod IP 直连不通"，就一定是 CNI/底层网络问题；如果"Service IP 不通但 Pod IP 通"，问题一定在 kube-proxy 或 Service 配置层。这条分界线能省掉一半排查时间。

## 1.2 一次请求经过的完整链路

以"集群外用户 → Ingress → Service → Pod"为例，数据包实际穿过的每一层：

```text
┌──────────────────────────────────────────────────────────────┐
│  Client (外部)                                                │
└───────────────────────┬──────────────────────────────────────┘
                        ↓  LB / NodePort / 弹性IP
┌──────────────────────────────────────────────────────────────┐
│  Node A                                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ eth0 → iptables/IPVS (DNAT 到 Ingress Controller Pod)   │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Ingress Controller Pod (nginx)                          │  │
│  │   → 查路由 → 访问后端 Service ClusterIP                  │  │
│  │   → iptables/IPVS 再次 DNAT 到 Endpoints                │  │
│  └────────────────────────────────────────────────────────┘  │
│  cni0 / flannel.1 / vxlan.calico (Overlay 或 BGP 路由)        │
└───────────────────────┬──────────────────────────────────────┘
                        ↓  跨节点
┌──────────────────────────────────────────────────────────────┐
│  Node B                                                       │
│  veth pair → cni0 → Pod (10.244.x.x)                          │
└──────────────────────────────────────────────────────────────┘
```

任何一次"网络不通"，都必须先定位它卡在链路的哪一段：**外部入口 → DNAT 规则 → Overlay/路由 → Pod 网卡 → 应用监听**。

## 1.3 必须掌握的 Linux 网络原语

K8s 网络问题最终都会落到 Linux 内核对象上，排障时需要直接操作它们：

| 对象 | 作用 | 常用查看命令 |
|------|------|-------------|
| `netns` | Pod 的隔离网络空间 | `lsns` / `ip netns` |
| `veth pair` | 一端在 Pod、一端在网桥 | `ip -d link show` |
| `cni0` / `docker0` | 节点内 Pod 的 Linux 网桥 | `bridge link` / `brctl show` |
| `iptables` / `IPVS` | Service 转发规则 | `iptables-save` / `ipvsadm -Ln` |
| `conntrack` | 连接跟踪表（NAT 状态） | `conntrack -L` / `cat /proc/sys/net/netfilter/nf_conntrack_count` |
| `calico/felix`、`flannel`、`cilium` | CNI 数据面 | `calicoctl` / `cilium status` |

进入 Pod 网络空间抓包的经典手法：

```bash
# 1. 找到 Pod 的容器 ID 与 PID
crictl ps --name <container> -q
crictl inspect <container-id> | grep -i pid

# 2. 进入该 PID 的 network namespace 抓包
nsenter -t <pid> -n tcpdump -i eth0 -nn port 8080
```

## 1.4 网络排障通用五步法

1. **确认现象边界**：是"全集群不通"、"跨节点不通"、"只有某个 Service 不通"，还是"只有 DNS 不通"。范围越广，越偏底层组件。
2. **验证 Pod IP 直连**：绕开 Service，直接 `curl <podIP>:<port>`。
3. **验证 Service 与 Endpoints**：`kubectl get endpoints`，确认后端存在。
4. **验证 DNAT 规则**：节点上看 iptables/IPVS 是否有对应链。
5. **验证底层连通性**：节点间 ping/telnet、CNI 组件状态、路由表。

---

# 第 2 章：Pod 间通信异常排障

## 2.1 同节点 Pod 互通问题

同节点内 Pod 通信通常经过 `cni0` 网桥（或 Cilium 的 eBPF 直接转发），不经过物理网络。若只有"同节点"不通，重点查：

```bash
# 节点上网桥与 veth 是否成对存在
ip -d link show type veth
bridge link show | grep <pod-veth-name>

# 网桥是否处于 UP 状态
ip addr show cni0
```

常见根因：

1. **容器运行时未正确创建 veth**：containerd 异常或 CNI 二进制缺失（`/opt/cni/bin` 下缺少插件文件）。
2. **`net.ipv4.ip_forward` 被关闭**：

```bash
sysctl net.ipv4.ip_forward          # 期望输出 = 1
# 若为 0，某些安全基线脚本会把它关掉，导致跨 Pod/跨节点全部失效
```

3. **`br_netfilter` 模块未加载**：表现为网桥上 iptables 规则"不生效"，NetworkPolicy 形同虚设：

```bash
lsmod | grep br_netfilter
sysctl net.bridge.bridge-nf-call-iptables   # 期望 = 1
```

> 经典坑：Calico 要求 `SKIP_IPTABLES_FP` 等参数与内核模块配合，模块没加载时报"NetworkPolicy 偶发失效"，非常难复现。

## 2.2 跨节点 Pod 互通问题

跨节点依赖 CNI 的 Overlay（VXLAN）或路由（BGP）能力。排障顺序：

```bash
# 1. CNI 组件自身是否健康
kubectl get pods -n kube-system -o wide | grep -E "calico|flannel|cilium"

# 2. 节点间是否有路由（Calico BGP 模式）
calicoctl node status          # 查看 BGP peer 是否 Established

# 3. Overlay 模式的 UDP 端口是否被防火墙拦截
#    Flannel: UDP 8472 ；Calico VXLAN: UDP 4789 ；Cilium Geneve: UDP 6081
ss -ulnp | grep -E "8472|4789|6081"
```

常见根因：

1. **云厂商安全组未放行 Overlay 端口**：新建节点池后最常见，表现为"扩容出来的节点全部跨节点不通"。
2. **节点跨可用区/跨子网路由不通**：底层 VPC 路由表或 BGP 未配置。
3. **Pod CIDR 与节点网段重叠**：CNI 路由被节点本地路由覆盖，表现为"只有某些 IP 段不通"。
4. **节点重启后 CNI 残留**：`kubelet` 拿不到网络，Pod 出现 `NetworkNotReady` 事件。

**处置手段：**

```bash
# 重启异常节点上的 CNI agent（一般 DaemonSet 会自动恢复）
kubectl delete pod -n kube-system <calico-node-xxxxx>

# 彻底恢复：节点上清理残留后重启 kubelet 与 containerd
systemctl restart containerd && systemctl restart kubelet
```

## 2.3 Pod 拿不到 IP 地址

现象是 Pod 长期 `ContainerCreating`，`describe` 报错：

```text
Warning  FailedCreatePodSandBox  kubelet
  Failed to create pod sandbox: rpc error: code = Unknown desc =
  failed to setup network for sandbox "...": plugin type="calico"
  failed (add): error getting ClusterInformation: connection is
  unauthorized
```

| 报错关键词 | 根因方向 |
|-----------|---------|
| `no IP addresses available in range` | 节点 Pod CIDR 已耗尽（见 2.4） |
| `plugin type="..." failed (add)` | CNI 配置文件或插件二进制损坏 |
| `connection is unauthorized` | CNI 组件访问 API Server 的凭据/证书过期 |
| `host name not found` | CNI 无法解析节点名（DNS 故障） |
| `ipamd ... Insufficient IPv4 address space` | 云 CNI（如 VPC CNI）ENI/IP 配额不足 |

## 2.4 单节点 Pod 数量达到上限

Flannel/Calico 默认每节点 `Pod CIDR` 为 `/24`（254 个 IP）；但若集群按 `--node-cidr-mask-size` 分配更小网段，或云 VPC CNI 按 ENI 数量限制 IP，都会导致：

```text
0/5 nodes are available: 5 Too many pods.
```

**排查与处置：**

```bash
# 查看节点已分配/可分配 Pod 数
kubectl describe node <node> | grep -E "Capacity|Allocatable|Non-terminated"

# 查看 kubelet 的 max-pods
ps -ef | grep kubelet | grep -o "max-pods=[0-9]*"
```

- 调大 `--node-cidr-mask-size`（如 /25 → /24），需重建集群或使用支持变更的方案。
- 调大 kubelet `--max-pods`（同时确认节点 IP 资源足够）。
- 云 VPC CNI 场景：启用 `WARM_IP_TARGET` / `PREFIX_DELEGATION` 提升单节点 IP 密度。

## 2.5 综合案例：扩容节点后新 Pod 全部跨节点不通

**场景**：集群扩容了 2 个新节点，新节点上的 Pod 与老节点 Pod 互访超时，同节点内正常。

排查步骤：

1. 确认现象边界——老节点之间互通正常，只有涉及新节点的流量不通 → 指向新节点的底层网络。

```bash
kubectl exec -n default <old-pod> -- ping -c 2 <new-pod-ip>   # 超时
```

2. 在新节点检查 Overlay 端口与路由：

```bash
ip route | grep -E "flannel|calico|cilium"    # 存在隧道，说明 CNI 已初始化
ss -ulnp | grep 8472                          # 监听存在
```

3. 从新节点 telnet 老节点的 UDP 隧道（用 `traceroute -U` 或直接抓包）：

```bash
nsenter -t 1 -n tcpdump -i eth0 -nn 'udp port 8472'
# 只看到发出的包，没有回应
```

4. 检查云安全组规则：新节点所属安全组缺少"允许组内节点互通 All Traffic"的规则。

**根因**：新节点池使用了独立安全组，未放行 VXLAN UDP 8472。

**解决**：将新节点加入正确安全组（或补一条组内互通规则），跨节点流量立即恢复。

> 教训：CNI 的"隧道端口"必须在安全组/防火墙中放行。扩容 SOP 里应包含一次跨节点 Pod 连通性验证。

## 2.6 章末小结

- 先用"Pod IP 直连是否通"把问题分成 CNI 层与 Service 层。
- 同节点不通 → 查网桥/veth/ip_forward/br_netfilter；跨节点不通 → 查 CNI 组件、路由、隧道端口、安全组。
- Pod CIDR 耗尽与 ENI 配额是"规模型"故障，靠监控而非事后排查。

---

# 第 3 章：DNS 解析异常排障

## 3.1 K8s DNS 的完整链路

```text
应用调用 getaddrinfo("web-svc")
   ↓
/etc/resolv.conf（Pod 内）
   nameserver 10.96.0.10        ← CoreDNS Service ClusterIP
   search default.svc.cluster.local svc.cluster.local cluster.local
   options ndots:5
   ↓
按 search 域依次拼接尝试（ndots=5 → 点数<5 时优先走 search）
   web-svc.default.svc.cluster.local.
   ↓
CoreDNS（kube-system/coredns Pod，iptables/IPVS 负载均衡）
   ↓
Kubernetes 插件：直接读 API Server 的服务注册表 → 返回 A 记录
（非集群域名则上游转发到 VPC DNS / 公网 DNS）
```

关键点：**CoreDNS 的 ClusterIP（默认 `10.96.0.10`）由 kube-proxy 维护**，因此"DNS 全部失效"往往同时意味着 kube-proxy 或 Endpoints 出了问题。

## 3.2 排查入口

```bash
# 1. CoreDNS 是否健康
kubectl -n kube-system get pods -l k8s-app=kube-dns -o wide
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=100

# 2. CoreDNS Service 与 Endpoints
kubectl -n kube-system get svc,endpoints coredns

# 3. 在业务 Pod 内做定向测试
kubectl exec -it <pod> -- sh
nslookup kubernetes.default
cat /etc/resolv.conf
```

区分两类现象非常有用：

| 现象 | 含义 |
|------|------|
| `Server: 10.96.0.10` + `can't resolve` | CoreDNS 可达，但解析失败（配置/后端数据问题） |
| `connection timed out; no servers could be reached` | 根本连不上 CoreDNS（kube-proxy/NetworkPolicy/conntrack） |

## 3.3 常见原因与解决方案

### 3.3.1 ndots 导致解析放大与超时

`options ndots:5` 意味着：域名点数少于 5 时，**先尝试所有 search 域**。对于 `api.external.com`（2 个点），解析顺序变成：

```text
api.external.com.default.svc.cluster.local  → NXDOMAIN
api.external.com.svc.cluster.local          → NXDOMAIN
api.external.com.cluster.local              → NXDOMAIN
api.external.com                            → 命中
```

一次业务域名解析要发 4 次查询。高 QPS 服务叠加 CoreDNS 副本不足，就会出现"偶发 DNS 超时"。

**优化手段：**

```yaml
dnsConfig:
  options:
    - name: ndots
      value: "2"
```

- 应用侧优先写完整域名（`svc.namespace.svc.cluster.local` 或 FQDN），可跳过 search 拼接。
- CoreDNS 启用 `forward ... max_concurrent`、`cache 30`（默认已有 cache），并保证副本数与节点数匹配（配合 `cluster-proportional-autoscaler`）。

### 3.3.2 conntrack 竞争导致 DNS 丢包

这是大规模集群最隐蔽的 DNS 故障：UDP 无连接，当 CoreDNS 收到大量并发查询时，`nf_conntrack` 表项新建与删除发生**竞态**，UDP 回包被判定为"无效流量"直接丢弃，表现为**随机 5 秒超时后重试成功**。

**证据特征：**

- `RESOLV_CONF` 中只有一个 nameserver；
- 抓包只见查询无响应；
- 内核 conntrack drop 计数增长：

```bash
conntrack -S                 # 关注 insert_failed / drop
cat /proc/sys/net/netfilter/nf_conntrack_count
```

**解决方案：**

- **node-local DNS（强烈推荐）**：在每个节点部署 `NodeLocal DNSCache` DaemonSet，`dnsConfig` 指向本节点 `169.254.20.10`，把 UDP 查询收敛为本地 TCP，规避跨节点 conntrack：

```yaml
dnsConfig:
  nameservers:
    - 169.254.20.10
  searches:
    - default.svc.cluster.local
    - svc.cluster.local
    - cluster.local
  options:
    - name: ndots
      value: "2"
```

- 或为 CoreDNS Service 设置 `spec.clusterIP: None`（无头服务）+ Pod 内多 nameserver 轮询。
- 调大 `nf_conntrack_max`，但只是缓解，不是根治。

### 3.3.3 NetworkPolicy 阻断了 DNS 流量

集群启用"默认拒绝"NetworkPolicy 后，若未显式放行 DNS，Pod 连 CoreDNS 都不通，症状是"所有域名都解析不了，但直连 IP 正常"。

```bash
# 查看是否选中了 DNS 相关策略
kubectl get netpol -A
```

**必须放行的两条：**

```yaml
# kube-system 侧：允许访问 CoreDNS
- to:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: kube-system
  - podSelector:
      matchLabels:
        k8s-app: kube-dns
  ports:
  - protocol: UDP
    port: 53
  - protocol: TCP
    port: 53
```

> 注意：很多 CNI 的 DNS 放行策略会漏掉 **TCP 53**，导致大数据包（响应超过 512 字节）截断后走 TCP 时失败，表现为"某些 Service 域名解析特别慢"。

### 3.3.4 headless Service 与 Endpoints 就绪延迟

无头 Service（`clusterIP: None`）直接返回 Pod IP 列表。若 Pod 尚未 Ready 或 Endpoints 更新延迟，解析会返回空结果或返回"已终止 Pod 的 IP"，导致 `connection refused`。

**处置：**

- 应用侧 DNS 缓存要设 TTL（JVM 的 `networkaddress.cache.ttl`、Go 程序避免长生命周期 `net.Dialer`）。
- StatefulSet 场景确认 Pod 的 DNS 记录形如 `pod-0.headless-svc.ns.svc.cluster.local`。

### 3.3.5 集群外域名解析失败

集群内域名正常、公网域名失败，说明 CoreDNS 的 `forward` 上游配置有问题。

```bash
kubectl -n kube-system get coredns -o yaml   # 或直接看 ConfigMap
kubectl -n kube-system get configmap coredns -o yaml
```

典型 Corefile：

```text
.:53 {
    errors
    health
    cache 30
    kubernetes cluster.local in-addr.arpa ip6.arpa {
      pods insecure
      fallthrough in-addr.arpa ip6.arpa
    }
    forward . /etc/resolv.conf      # ← 上游依赖节点 resolv.conf
}
```

**常见坑**：节点 `/etc/resolv.conf` 指向了 VPC 内网 DNS，但安全组未放行 UDP 53 出方向；或 `search` 里含公网域导致 CoreDNS 自身查询被拼接放大。

### 3.3.6 hostAliases 与 ExternalName

临时绕过 DNS 的手段（生产慎用）：

```yaml
spec:
  hostAliases:
  - ip: "10.0.5.20"
    hostnames:
    - "legacy-db.internal.com"
```

`ExternalName` 类型 Service 依赖 CoreDNS 做 CNAME 转发，一旦上游 DNS 不可用，`curl <svc>` 直接失败，但 `kubectl get svc` 看起来一切正常：

```yaml
kind: Service
spec:
  type: ExternalName
  externalName: db.prod.example.com
```

## 3.4 综合案例：只有 Java 服务解析外部域名偶发超时

**场景**：Node.js 服务正常，Java 服务间歇性 `UnknownHostException`，且都在同一节点。

排查步骤：

1. 用 `ndots` 视角复现：

```bash
kubectl exec -it <java-pod> -- sh
# 直连 CoreDNS 查询，观察耗时
nslookup external-api.example.com 10.96.0.10   # 0.02s 正常
```

2. 抓包发现 Java 服务查询量远高于 Node 服务（它自己实现了一个 `InetAddress` 解析循环）。

3. 检查 conntrack：

```bash
conntrack -S | grep -E "insert_failed|drop"
# insert_failed=18342
```

4. 确认 JVM DNS 缓存：`networkaddress.cache.ttl` 未设置，默认对失败结果缓存 10 秒，导致"一次超时后连续报错"。

**根因**：`ndots:5` + 高并发 UDP 查询 → conntrack 丢包 → 超时 → JVM 缓存失败结果放大影响面。

**解决**：

- 部署 NodeLocal DNSCache；
- Pod 显式设置 `ndots:2`；
- 外部域名改为 FQDN（结尾加 `.`），跳过 search 拼接；
- JVM 加 `-Dsun.net.inetaddr.negative.ttl=1`。

## 3.5 章末小结

- DNS 排障第一刀：**连不上 CoreDNS（转发层）** vs **连得上但解析失败（CoreDNS 层）**。
- `ndots:5` 与 conntrack 竞争是大集群 DNS 抖动的两大元凶，NodeLocal DNSCache 是标准解法。
- NetworkPolicy 记得同时放行 UDP/TCP 53。

---

# 第 4 章：Service 流量与 kube-proxy 排障

## 4.1 kube-proxy 的两种模式

| 模式 | 实现 | 特点 | 典型故障 |
|------|------|------|---------|
| `iptables` | 链式规则 + 随机命中 | 规则数随 Service 规模线性膨胀 | Service 多时规则同步慢、CPU 高 |
| `IPVS` | 内核 IPVS 负载均衡 | O(1) 查找，支持 rr/lc 等算法 | `kube-ipvs0` 网段冲突、模块缺失 |

```bash
# 确认模式
kubectl -n kube-system get cm kube-proxy -o yaml | grep mode
#   mode: "ipvs"
```

```bash
# iptables 模式：查看 Service 链
iptables-save | grep 'KUBE-SVC' | grep web-svc
iptables-save -t nat | grep -A 2 'KUBE-SVC-XXXXXX'

# IPVS 模式：查看虚拟服务与后端
ipvsadm -Ln -t 10.96.100.42:80
ipvsadm -Ln --stats
```

## 4.2 规则未同步：Service 存在但不通

现象：Endpoints 正常，但节点上 `iptables`/`IPVS` 没有对应规则。

```bash
# 1. 对比 Endpoints 与规则
kubectl get endpoints web-svc -n prod -o jsonpath='{.subsets[*].addresses[*].ip}'

# 2. 看 kube-proxy 是否正常工作
kubectl -n kube-system logs -l k8s-app=kube-proxy --tail=50 | grep -i error
```

常见根因：

1. **kube-proxy 因 API Server 限流而落后**：日志出现 `Event received with no metadata` 或 watch 断连重连。
2. **Service 无 selector 且未手写 Endpoints/EndpointSlice**：规则建了但没有后端。
3. **IPVS 模式宿主机 `kube-ipvs0` 抢占了与 Pod CIDR/VPC 网段重叠的 ClusterIP**，表现为"只有某些 Service 不通"。
4. **节点上有人为操作清空了 iptables**（`iptables -F`）或 firewalld 重启导致链被覆盖。

> 经典坑：firewalld 与 kube-proxy 抢规则。规则应为 `iptables -P FORWARD ACCEPT` 且不要使用 firewalld，改用 `iptables` 直管。

## 4.3 SNAT 与源地址丢失（hidden 问题）

Service 转发默认会做 SNAT，导致后端 Pod 看到的**源 IP 是节点 IP 而非客户端 IP**，影响限流、审计、白名单。

控制它的是 `externalTrafficPolicy`：

```yaml
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local    # 保留源 IP，只转发到本节点 Pod
```

| 取值 | 源 IP | 副作用 |
|------|-------|--------|
| `Cluster`（默认） | 被 SNAT 成节点 IP | 负载均衡均匀 |
| `Local` | 保留客户端真实 IP | 只有跑 Pod 的节点能接流量，**健康检查节点可能被云 LB 摘除**，可能出现流量不均 |

**典型故障：`Local` 模式下 LB 健康检查失败**

云 LB 对所有节点做 TCP 健康检查，但 `Local` 只在本节点有 Pod 时才开端口，导致节点被大量摘除 → 服务容量骤降。

```bash
kubectl get pods -A -o wide -l app=web-svc   # 检查是否所有节点都有 Pod
kubectl get svc <svc> -o yaml | grep -A 2 healthCheckNodePort
```

**解决**：用 DaemonSet 保证每节点有 Pod，或改回 `Cluster` + `X-Forwarded-For`/Proxy Protocol 传递真实 IP。

## 4.4 Session Affinity 与连接不均

```yaml
spec:
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800
```

开启后同一客户端固定打到一个后端，一旦该后端 Pod 所在节点负载高，就会出现"个别 Pod CPU 打满、其他空闲"。排障时先看 `kube-proxy` 的 iptables `-m recent` 链或 IPVS `kernedl persistent` 条目：

```bash
ipvsadm -Ln --persistent 600
```

**解决**：改为应用层会话（Redis/JWT），或在 Ingress 层做一致性哈希，避免 L4 粘滞。

## 4.5 Headless / 无头 Service 与 EndpointSlice

K8s 1.21+ 用 `EndpointSlice` 取代 `Endpoints`，单片最多 100 个端点，大规模 Service 会分多片：

```bash
kubectl get endpointslices -l kubernetes.io/service-name=web-svc -n prod
```

**排障点**：

- 端点数量巨大时，某些 CNI/kube-proxy 版本对 EndpointSlice 的兼容性有 bug，表现为"只有一部分 Pod 能收到流量"。
- 用 `kubectl get ep` 看到的顺序与 `ipvsadm` 后端数量对不上 → 检查 EndpointSlice 是否被截断。

## 4.6 NodePort 与端口范围

```bash
kubectl get svc -A | grep NodePort
# 测试本节点端口是否真的监听
ss -lntp | grep 30080
```

- `--service-node-port-range` 被改小导致 `allocate port` 冲突；
- 节点安全组未放行 NodePort 段（默认 `30000-32767`）；
- `kube-proxy` 只在本节点有后端时才监听 NodePort（`Local` 策略下）。

## 4.7 综合案例：Service 偶发 connection refused，重启 Pod 就好

**场景**：某 NodePort Service 每几分钟出现一次秒级 `connection refused`，重启对应 Pod 后立即恢复。

排查步骤：

1. 看 `kubectl get endpoints`，发现异常 Pod 的 IP 已在 Endpoints 中（说明 kube-proxy 已下发规则）。
2. 抓包确认 SYN 发到后端 Pod 后收到 RST：

```bash
nsenter -t <pid> -n tcpdump -i eth0 -nn 'tcp port 8080 and tcp[tcpflags] & tcp-rst != 0'
```

3. 在 Pod 内 `ss -lntp` 发现应用只监听了 `127.0.0.1:8080`。

**根因**：应用绑定了 loopback，同节点 kube-proxy 转发过来的流量来自 `cni0` 网关地址，被拒绝。之所以"偶发"，是因为只有被调度到该 Pod 所在节点的流量才失败。

**解决**：应用监听 `0.0.0.0:8080`。

> 教训：`connection refused` = 包到达目标但无人监听，先查 `listen address`，而不是网络链路。

## 4.8 章末小结

- 先分清"规则没同步"还是"规则同步了但转发失败"：看 `iptables-save`/`ipvsadm`。
- 源 IP、健康检查、流量不均，几乎都出自 `externalTrafficPolicy` 与 affinity 的选择。
- `connection refused` 优先怀疑应用监听地址；`timeout` 优先怀疑链路与防火墙。

---

# 第 5 章：NetworkPolicy 排障

## 5.1 NetworkPolicy 生效的三前提

1. **CNI 插件支持**（Calico/Cilium 支持；Flannel 本身不支持，需要配合 canal 等方案）。
2. 命名空间被 `podSelector` **选中**（没被选中的 Pod 不受限，仍默认全通）。
3. 表达式正确：`namespaceSelector` / `podSelector` / `ipBlock` 三者的组合语义是**笛卡尔积**，写错一个 selector 就会放大或收紧范围。

> 关键认知：NetworkPolicy 是"**白名单累加**"模型。只要有任何一条策略选中了某 Pod 的 Ingress，该 Pod 的其他 Ingress 流量就全部默认拒绝——除非被某条策略显式允许。

## 5.2 排障入口

```bash
# 列出所有策略
kubectl get netpol -A -o wide

# 查看某个 Pod 实际"被允许"的进出（Calico）
kubectl exec -it <calico-pod> -n kube-system -- calico-node -wireguard status 2>/dev/null
calicoctl get workloadendpoint -o wide

# Cilium 场景：策略可视化
cilium status
cilium policy get
```

## 5.3 常见写法错误

### 5.3.1 只写 podSelector 不写 namespaceSelector

```yaml
ingress:
- from:
  - podSelector:
      matchLabels:
        app: frontend
```

含义：**仅允许"同命名空间"内的 frontend**。跨命名空间时全部被拒。

```yaml
# 正确：跨命名空间必须叠加 namespaceSelector
ingress:
- from:
  - namespaceSelector:
      matchLabels:
        name: web
    podSelector:
      matchLabels:
        app: frontend
```

注意 `- namespaceSelector + podSelector`（**同一条目内的与关系**）与分两条列表项（**或关系**）的区别，这是最高频的笔误来源。

### 5.3.2 漏掉 DNS 放行

任何启用默认拒绝的命名空间，**必须显式放行 kube-dns 的 UDP/TCP 53**，否则 Pod 内所有域名解析失败，故障现场看起来像"网络抖动"。

### 5.3.3 忘了 Ingress Controller 与 LB 健康检查

```yaml
ingress:
- from:
  - namespaceSelector:
      matchLabels:
        name: ingress-nginx
  ports:
  - protocol: TCP
    port: 8080
```

外部 LB/健康检查探测若未放行，会导致 Ingress 无法访问后端 Pod（表现为间歇 502/503）。

### 5.3.4 Egress 限制导致应用连不上数据库/外部 API

```yaml
policyTypes:
- Egress
egress:
- to:
  - podSelector:
      matchLabels:
        app: postgres
  ports:
  - protocol: TCP
    port: 5432
```

只允许 PG 而没允许 DNS → 连 `postgres` 这个名字都解析不了。**加 DNS 是 Egress 策略的标配**。

## 5.4 验证与二分定位

```bash
# 1. 直接测连通性（绕开应用）
kubectl run t1 --rm -it --image=nicolaka/netshoot --restart=Never -- bash
curl -sv --max-time 3 http://<pod-ip>:8080/health

# 2. 二分定位：临时删除可疑策略
kubectl delete netpol suspect-policy -n prod
# 通了 → 就是它；不通 → 继续排查其他层
```

**最佳实践**：策略灰度上线时，用 **Cilium `--enable-policy=audit`** 或 Calico 的 `logSeverity` 观察被拒绝的流量，再收紧。

```bash
# 查被丢弃的包（Calico / iptables）
iptables -L CALI-FORWARD -n -v --line-numbers | grep -i drop
journalctl -k | grep -i 'cali.*drop' | tail -50
```

## 5.5 综合案例：一次 NetworkPolicy 上线导致"集群外访问全 502"

**场景**：给生产命名空间加了 `default-deny-ingress`，随后所有外部请求经 Ingress 后返回 502。

排查步骤：

1. Ingress Controller 日志：`upstream timed out`，说明请求到了 Controller，但转发到后端 Pod 失败。
2. Controller Pod 到后端 Pod 的连通性测试：

```bash
kubectl -n ingress-nginx exec -it <controller-pod> -- curl -sv --max-time 3 http://<backend-pod-ip>:8080/
# connection timed out
```

3. 后端 Pod 所在命名空间存在默认拒绝策略，且 `Ingress` 条目只允许了 `name: web` 标签的命名空间，而 `ingress-nginx` 命名空间没有该标签：

```bash
kubectl get ns ingress-nginx --show-labels
# kubernetes.io/metadata.name=ingress-nginx   ← 缺少 name=web
```

**根因**：策略依赖自定义标签 `name: web`，而 ingress-nginx 命名空间未打标。

**解决**：

```bash
kubectl label ns ingress-nginx name=web
```

**改进**：NetworkPolicy 使用内建标签 `kubernetes.io/metadata.name`（1.21+ 自动存在），并在 CI 中增加一条"跨命名空间访问回归用例"。

## 5.6 章末小结

- NetworkPolicy 不生效先确认 CNI 支持，再看 selector 是否真正选中 Pod。
- 一旦启用，**记得放行 DNS、Ingress Controller、LB 健康检查**这三件套。
- 用"删策略验证 + audit 日志"做二分，不要靠猜。

---

# 第 6 章：底层网络与 MTU / 时间 / 内核参数

## 6.1 MTU 不一致：最阴险的"小包能通大包不通"

**症状**：小请求正常，一旦返回较大内容（如超过 1400 字节）就卡住直到超时；`kubectl exec curl` 挂住但 `ping` 正常。

原因：Overlay（VXLAN/Geneve/IPsec）会额外占用 50~75 字节包头，若 Pod 网卡 MTU 与物理网络不匹配，需要分片的包被静默丢弃。

```bash
# 节点与 Pod 网卡 MTU
ip addr show | grep -E "mtu"
# Pod 内
ip link show eth0        # 常见 1440 / 1450 / 8981

# 云环境（巨型帧 9001）与自建 Calico IPIP（1480）叠加最常见
ping -M do -s 1472 <target>    # 逐步二分找出实际可通的分片大小
```

**处置**：

```text
Flannel:  kube-controller-manager --pod-manifest-path
          flannel 配置里指定 --backend 与 mtu
Calico:   felixConfiguration 的 vxlanMTU / ipipMTU
Cilium:   cilium config mtu
通用：    节点 MTU = 云网络 MTU(9001) - Overlay 开销
```

> 排查口诀：`ping` 通但 `curl` 卡 → 立刻怀疑 MTU。

## 6.2 ARP / IP 地址冲突与泄漏

节点重启或 Pod 快速重建后，出现过 `IP in use` 或"两个 Pod 同 IP"：

```bash
arping -I eth0 <pod-ip>
ip neigh | grep <pod-ip>       # 查看 ARP 表项
calicoctl ipam check           # Calico IPAM 一致性检查
```

**处置**：清理 CNI 残留（`/var/lib/cni/networks`），删除 IP 泄漏的 WorkloadEndpoint，必要时重启节点 CNI agent。

## 6.3 内核网络参数基线

```bash
sysctl -a 2>/dev/null | grep -E "conntrack_max|ip_forward|bridge-nf|tcp_tw_reuse|somaxconn"
```

| 参数 | 生产建议 | 影响 |
|------|---------|------|
| `net.ipv4.ip_forward` | 1 | 关闭导致跨节点全断 |
| `net.bridge.bridge-nf-call-iptables` | 1 | NetworkPolicy 失效 |
| `net.netfilter.nf_conntrack_max` | ≥ 524288 | 表满导致随机丢包 |
| `net.ipv4.tcp_tw_reuse` | 1（客户端方向） | 高并发短连接端口耗尽 |
| `net.core.somaxconn` | ≥ 1024 | 应用 backlog 溢出，偶发拒绝连接 |
| `net.ipv4.conf.all.rp_filter` | 0 或 loose | 严格反向路径校验会丢 Overlay 包 |

> 注意：`rp_filter=1`（strict）在 Calico IPIP/BGP 场景下是著名的"隐性丢包"来源，务必改成 loose（2）或 0。

## 6.4 conntrack 表满

```bash
dmesg | grep -i "nf_conntrack: table full, dropping packet"
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max
```

**处置**：调大 `nf_conntrack_max`，缩短 `nf_conntrack_tcp_timeout_established`，并确保 UDP DNS 走 NodeLocal（见 3.3.2）。

## 6.5 时钟不同步

节点时间漂移会连锁导致：证书校验失败、etcd 选举异常、日志时序错乱、Pod 的 `imagePullPolicy`/Token 提前过期。

```bash
chronyc sources -v
timedatectl status
```

## 6.6 综合案例：跨可用区调用延迟从 1ms 涨到 300ms

**场景**：某服务调用同集群另一可用区的 Pod，延迟飙升，但同可用区内正常。

排查步骤：

1. 确认不是应用：

```bash
kubectl exec <pod> -- ping -c 10 <cross-zone-pod-ip>   # avg 280ms
kubectl exec <pod> -- ping -c 10 <same-zone-pod-ip>    # avg 0.3ms
```

2. 检查 CNI 模式：Calico 为 `bird` BGP 全互联，跨可用区时通过 VPC 路由，MTU 从 9001 降至 1500，触发大量分片。

```bash
ip route get <cross-zone-ip>        # via 10.0.0.1 dev eth0（走 VPC 路由）
ping -M do -s 8973 ...              # 大包被丢弃
```

**根因**：跨可用区链路不支持巨型帧，Calico 未按链路自动调整 IPIP MTU。

**解决**：将 Calico `ipipMTU` 由 1480 调整为 1460，并在同可用区场景优先使用本地亲和调度（`topologyKeys` / `podAntiAffinity` + 区域打散）。

## 6.7 章末小结

- MTU 是"看起来像应用慢"的网络问题，用 `ping -M do -s` 二分定位。
- conntrack 表满、`rp_filter`、`ip_forward`、桥接 netfilter 是节点层的四大"沉默杀手"。
- 底层参数应固化为集群基线（DaemonSet + 节点初始化脚本），并纳入监控。

---

# 第 7 章：排障工具链与最佳实践

## 7.1 常用网络排障工具箱

| 工具 | 用途 | 备注 |
|------|------|------|
| `netshoot` 镜像 | Pod 内集成 tcpdump/dig/nsenter | 生产应急首选 |
| `kubectl debug` | 共享 netns 的临时调试容器 | `--target` 复用业务 Pod 网络空间 |
| `nsenter -t <pid> -n` | 进入 Pod 网络空间抓包 | 节点侧操作 |
| `cilium hubble / observe` | L7 流量可视化 | Cilium 集群强推 |
| `calicoctl` / `kubectl-plugin` | BGP 状态、IPAM 检查 | Calico 集群必备 |
| `ipvsadm` / `iptables-save` | Service 规则审计 | 判断 kube-proxy 同步 |
| `mtr` / `traceroute -T` | 路径与丢包率 | Overlay 场景建议 TCP 模式 |
| `kubednsdiag` | DNS 链路诊断 | 定位 CoreDNS 层与上游转发问题 |

**`kubectl debug` 的优雅用法**（不进入业务容器，共享网络命名空间）：

```bash
kubectl debug -it <pod> --image=nicolaka/netshoot \
  --target=<container> --profile=netshoot
# 进去后可以直接 tcpdump 业务容器的 eth0，且不影响业务
```

## 7.2 网络问题定位速查表

| 症状 | 最可能层次 | 首查动作 |
|------|-----------|---------|
| Pod 一直 `ContainerCreating` + NetworkNotReady | CNI / 运行时 | `describe pod` 事件 + CNI Pod 日志 |
| 跨节点不通、同节点正常 | 底层网络 / 安全组 | CNI 隧道端口 + 路由 + 安全组 |
| Service IP 不通、Pod IP 通 | kube-proxy / Endpoints | `ipvsadm -Ln`、`get endpoints` |
| 只有部分 Pod 收到流量 | EndpointSlice / readiness | `get endpointslices`、Pod Ready 状态 |
| 域名全解析失败 | CoreDNS / Policy | `nslookup kubernetes.default` |
| 偶发 5 秒解析超时 | conntrack / ndots | `conntrack -S`、NodeLocal DNSCache |
| 小包通大包卡 | MTU | `ping -M do -s` 二分 |
| 加策略后 502 | NetworkPolicy | 放行 DNS/Controller/LB 三件套 |

## 7.3 预防优于排障

1. **网络基线脚本化**：`ip_forward`、`br_netfilter`、`conntrack_max`、`rp_filter` 在节点初始化时固化。
2. **部署前连通性验证**：扩容 SOP 里加一条"跨节点 Pod ping + Service 访问"冒烟测试。
3. **NodeLocal DNSCache 默认安装**：把 DNS 问题消灭在 80%。
4. **策略灰度与审计模式**：NetworkPolicy 先 audit 再 enforce。
5. **可观测性**：Hubble / Calico 流日志 + conntrack 指标 + CoreDNS 指标，比事后抓包快 10 倍。

## 7.4 写在最后

K8s 网络排障的本质是**分层裁剪**：用"Pod IP 直连"把 CNI 层与 Service 层切开，用"小包/大包"把链路与 MTU 切开，用"UDP 5s 超时"把 conntrack 与解析逻辑切开。每一层都有自己的现场证据（veth、iptables、conntrack、日志），把它们串起来就是完整答案。

下一篇将聚焦存储链路的排障：PVC 为什么一直 Pending、卷挂载失败、CSI 组件与快照恢复。

---

**系列导航**：

- 系列一：Pending / CrashLoopBackOff / Service / Ingress
- 系列二（本文）：网络 - CNI / DNS / 连通性
- 系列三：存储 - PV / PVC / CSI
- 系列四：控制面与性能排障
