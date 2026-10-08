---
title: Kubernetes 排障实战系列（一）：Pending / CrashLoopBackOff / Service / Ingress
date: 2026-10-08 20:00:00
categories: [Kubernetes]
tags: [Kubernetes, 排障, Pending, CrashLoopBackOff, Service, Ingress, 运维]
---

# 第 1 章：引言 - K8s 排障方法论

## 1.1 为什么 Kubernetes 排障"难"

Kubernetes 是一个分布式编排系统。与传统单体应用"看日志、看进程"不同，K8s 的一个应用请求要经过 **控制面（Control Plane）** 与 **数据面（Data Plane）** 的多层协作才能最终完成。当应用"不通"或"起不来"时，问题可能出在调度器、kubelet、容器运行时、CNI、Service 代理、DNS、Ingress 控制器等任意一层。

```text
┌─────────────────────────────────────────────────────────────┐
│                        kubectl / API 请求                     │
└────────────────────────────┬────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│              控制面 Control Plane                             │
│   kube-apiserver → kube-scheduler → kube-controller-manager  │
└────────────────────────────┬────────────────────────────────┘
                             ↓ 调度决策 / 事件下发
┌─────────────────────────────────────────────────────────────┐
│                数据面 Data Plane（Node）                      │
│   kubelet → CRI(containerd/docker) → CNI → kube-proxy        │
└────────────────────────────┬────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│              Pod → Service → Endpoints → Ingress             │
└─────────────────────────────────────────────────────────────┘
```

排障的核心难点在于：**每一层都有各自的资源对象、日志和状态**，错误信息往往只是一条简短的 Event，真正的根因需要顺着链路逐层排查。

## 1.2 排障黄金法则

在动手之前，先建立一套通用的排查范式，能显著降低定位时间：

1. **从现象到对象**：先明确"谁出了问题"——是 Pod 起不来、Service 不通，还是 Ingress 404。
2. **从状态到事件**：`kubectl get` 看的是"当前状态"，`kubectl describe` 的 `Events` 段才是"为什么变成这样"。
3. **从事件到日志**：Pod 的 `Events` 只能告诉你"镜像拉不下来""探针失败"，真正的报错在容器日志里。
4. **从一层到下一层**：不要跨层猜。Pod → Service → Endpoints → Ingress → 外部，逐层验证。
5. **先排除环境，再怀疑业务**：多数排障的根因是配置、资源、网络，而不是应用本身的 bug。

## 1.3 排障命令速查表

| 目的 | 命令 |
|------|------|
| 查看所有命名空间 Pod | `kubectl get pods -A` |
| 查看 Pod 事件 | `kubectl describe pod <pod> -n <ns>` |
| 查看 Pod 完整定义 | `kubectl get pod <pod> -n <ns> -o yaml` |
| 查看容器日志 | `kubectl logs <pod> -n <ns> -c <container>` |
| 查看上一个容器日志（重启后） | `kubectl logs <pod> -n <ns> --previous` |
| 查看节点状态 | `kubectl get nodes -o wide` |
| 查看节点事件 | `kubectl describe node <node>` |
| 查看 Service 与端点 | `kubectl get svc,endpoints -n <ns>` |
| 查看 Ingress 配置 | `kubectl get ingress -n <ns> -o yaml` |
| 查看集群事件流 | `kubectl get events -n <ns> --sort-by=.lastTimestamp` |
| 进入容器调试 | `kubectl exec -it <pod> -n <ns> -- sh` |
| 资源使用 | `kubectl top pods -n <ns>` / `kubectl top nodes` |

---

# 第 2 章：Pod Pending 状态排障

## 2.1 什么是 Pending

Pod 的生命周期从 `Pending` 开始。当 kubectl 看到 Pod 停留在 `Pending` 状态时，意味着 **Pod 已经被 API Server 接受，但还没有成功调度并运行起来**。这通常发生在两个阶段之一：

- **调度阶段**：kube-scheduler 还没有为 Pod 找到合适的节点。
- **启动准备阶段**：节点已确定，但容器镜像拉取、存储卷挂载等尚未完成。

`Pending` 本身不是错误，而是"等待中"。排障的关键是搞清楚 **"在等什么"**。

## 2.2 排查入口

```bash
kubectl describe pod <pod-name> -n <namespace>
```

重点关注输出末尾的 `Events` 段，它会直接告诉你调度器或 kubelet 卡在哪里：

```text
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  3m    default-scheduler  0/3 nodes are available:
         1 Insufficient memory. 2 node(s) had untolerated taint.
```

## 2.3 常见原因与解决方案

### 2.3.1 集群资源不足（Insufficient CPU/Memory）

这是生产环境最高频的 Pending 原因。调度器在为 Pod 做资源预算时，发现没有任何节点能容纳它。

**现象：**

```text
0/3 nodes are available: 3 Insufficient memory, 3 Insufficient cpu.
```

**排查：**

```bash
# 查看节点资源分配情况
kubectl describe nodes | grep -A 5 "Allocated resources"

# 查看节点实时资源
kubectl top nodes
```

**解决方案：**

- 调低 Pod 的 `requests`（注意：`requests` 才是调度依据，`limits` 只是上限）。
- 扩容节点（Cluster Autoscaler 或手动加节点）。
- 驱逐低优先级 Pod（配合 PriorityClass 与抢占机制）。
- 检查是否有"僵尸"资源被不合理的 `requests` 占用。

> 关键认知：调度器只看 `resources.requests`，不看 `limits`。一个 `requests: 100m` 但 `limits: 4` 的 Pod，调度时只占 100m 的配额。

### 2.3.2 节点不匹配（NodeSelector / NodeAffinity / 污点容忍）

Pod 通过 `nodeSelector`、`nodeAffinity`、`taint/toleration` 表达"我只想/只能跑在某些节点上"，当没有节点满足时就会 Pending。

**现象：**

```text
0/3 nodes are available: 1 node(s) didn't match node selector, 2 node(s) had untolerated taint.
```

**排查：**

```bash
# 查看节点的标签
kubectl get nodes --show-labels

# 查看节点的污点
kubectl describe nodes | grep -i taints
```

**常见坑：**

1. **master 节点默认有污点** `node-role.kubernetes.io/control-plane:NoSchedule`，普通 Pod 若不显式容忍就无法调度上去（这通常是"故意"的）。
2. `nodeSelector` 标签名拼写错误，导致永远匹配不到。
3. 使用 `RequiredDuringSchedulingIgnoredDuringExecution` 硬亲和时，条件写反。

**解决方案：**

- 核对 `nodeSelector` 的 key/value 是否与节点标签一致。
- 为 Pod 添加对应 `tolerations`，或给节点移除/修改污点。
- 将硬亲和 `requiredDuringScheduling` 改为软偏好 `preferredDuringScheduling`。

### 2.3.3 存储卷未就绪（PVC 未绑定）

当 Pod 引用了一个无法绑定的 PVC（PersistentVolumeClaim）时，Pod 会一直等待卷挂载完成。

**现象：**

```text
Events:
  Warning  FailedScheduling  default-scheduler  pod has unbound immediate PersistentVolumeClaims
```

**排查：**

```bash
# 查看 PVC 状态（期望是 Bound）
kubectl get pvc -n <namespace>
# NAME   STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
# data   Pending                                      standard       5m
```

**常见原因：**

- 没有匹配的 PV（PersistentVolume）可供绑定。
- StorageClass 不存在，或动态供给器（provisioner）未部署。
- 请求的容量/访问模式/存储类与现有 PV 不匹配。

**解决方案：**

- 检查 `kubectl get storageclass`，确认对应的 provisioner 已就绪。
- 检查动态供给器的 Pod（如 `csi-*`、`nfs-subdir-external-provisioner`）是否正常。
- 手动创建符合要求的 PV 进行静态绑定。

### 2.3.4 端口或 HostPort 冲突

Pod 声明了 `hostPort`，但目标节点上该端口已被其他进程占用；或者 `hostNetwork` 模式下端口冲突。

**现象：**

```text
0/3 nodes are available: 3 node(s) didn't have free ports for the requested pod ports.
```

**解决方案：**

- 检查节点的端口占用情况，更换 `hostPort` 或改用 Service 暴露。
- 生产环境尽量避免使用 `hostPort`，它会让 Pod 与节点强绑定，削弱可调度性。

### 2.3.5 节点 NotReady

当集群中所有可用节点都处于 `NotReady` 时，Pod 自然无法调度。

```bash
kubectl get nodes
# NAME    STATUS     ROLES    AGE    VERSION
# node1   NotReady   <none>   10d    v1.28.0
```

进一步排查节点为何 NotReady：

```bash
kubectl describe node node1   # 查看 Conditions 段
# KubeletNotReady、CNI not ready、MemoryPressure、DiskPressure、PIDPressure
```

常见根因：kubelet 崩溃、containerd 异常、CNI 插件故障、节点磁盘/内存/进程数压力过大。

## 2.4 综合案例：Pod 一直 Pending，报 Insufficient cpu

**场景**：部署一个微服务后，Pod 始终 Pending，`describe` 显示 `Insufficient cpu`。

```bash
kubectl describe pod order-service-7b8c9d-abcde
```

排查步骤：

1. 看节点总资源与已分配资源：

```bash
kubectl describe nodes | grep -A 6 "Allocated resources"
```

发现 3 个节点 CPU 分配率已超过 90%，虽有 `limits` 远大于 `requests` 的情况，但调度按 `requests` 计算。

2. 检查是否有大额 `requests` 的"闲置" Pod：

```bash
kubectl get pods -A -o custom-columns=\
NAME:.metadata.name,NS:.metadata.namespace,CPU:.spec.containers[*].resources.requests.cpu
```

3. 结论：某批测试 Pod 未及时清理，占满了 `requests` 配额。清理后 Pod 成功调度。

> 教训：`requests` 是集群的"账面预算"，即使 CPU 实际空闲，只要 `requests` 之和超出节点可分配量，调度器也不会再往上放 Pod。

## 2.5 章末小结

- `Pending` = "等待中"，关键是读懂 `Events` 里调度器给出的理由。
- 按"资源 → 匹配规则 → 存储 → 端口 → 节点状态"的顺序逐一排查。
- 调度只看 `requests`，不看 `limits`；污点、亲和性、PVC 是三大高频"隐性"原因。

---

# 第 3 章：Pod CrashLoopBackOff 排障

## 3.1 什么是 CrashLoopBackOff

`CrashLoopBackOff` 表示容器**反复启动后立刻崩溃退出**。kubelet 会按照指数退避策略（10s → 20s → 40s → ... 上限 5 分钟）不断重启容器，但每次都以失败告终。

```text
NAME                     READY   STATUS             RESTARTS      AGE
web-app-6d8c9f-xyz      0/1     CrashLoopBackOff   12 (2m ago)   15m
```

关键信号是 `RESTARTS` 计数持续增长。注意：`CrashLoopBackOff` 是"结果"，不是"原因"，真正需要查明的是 **容器为什么退出**。

## 3.2 排查入口

### 第一步：看容器退出信息

```bash
kubectl describe pod <pod-name> -n <namespace>
```

查看 `Containers → Last State`，重点关注 **Exit Code** 与 **Reason**：

```yaml
Last State:     Terminated
  Reason:       OOMKilled
  Exit Code:    137
  Started:      ...
  Finished:     ...
```

### 第二步：看崩溃前的日志

容器重启后，`kubectl logs` 默认只能看到"当前容器"的日志。崩溃那一瞬间的输出要用 `--previous`：

```bash
kubectl logs <pod-name> -n <namespace> --previous --tail=200
```

## 3.3 Exit Code 速查

| Exit Code | 含义 | 常见根因 |
|-----------|------|---------|
| 0 | 正常退出 | 容器主动退出（如前台进程结束） |
| 1 | 应用错误 | 程序内部异常、配置错误 |
| 2 | 命令误用 | 入口命令写错 |
| 126 | 命令无法执行 | 权限问题、不是可执行文件 |
| 127 | 命令未找到 | 镜像里缺二进制、PATH 错误 |
| 137 | SIGKILL（9） | OOMKilled 或外部强杀 |
| 139 | SIGSEGV（11） | 段错误、内存越界 |
| 143 | SIGTERM（15） | 优雅终止（探针失败等） |

> 经验法则：`Exit Code 137` 且 `Reason: OOMKilled`，基本可以锁定为内存超限。

## 3.4 常见原因与解决方案

### 3.4.1 OOMKilled（内存超限）

容器内存超过 `limits.memory` 时，内核会触发 OOM Killer，直接 SIGKILL 进程。

**现象：**

```yaml
Last State:     Terminated
  Reason:       OOMKilled
  Exit Code:    137
```

**排查：**

```bash
# 查看容器内存使用
kubectl top pod <pod-name> -n <namespace>

# 查看节点 OOM 事件
kubectl get events -n <namespace> | grep -i oom
```

**解决方案：**

- 调大 `limits.memory`（先确认是不是内存泄漏）。
- 优化应用内存占用、排查内存泄漏（配合 heap dump / pprof）。
- 正确设置 JVM 等运行时的内存上限（如 `-Xmx` 要小于容器 `limits`）。

### 3.4.2 应用启动报错（Exit Code 1）

这是最常见的场景：应用自身因配置、依赖、连接失败而退出。

```bash
kubectl logs <pod-name> --previous
```

典型日志：

```text
Error: cannot connect to database host=postgres:5432 timeout
panic: runtime error: invalid memory address or nil pointer dereference
```

**解决方案：**

- 根据日志修正配置（环境变量、配置文件、依赖服务地址）。
- 数据库等服务未就绪时，加 `initContainer` 或重试逻辑。

### 3.4.3 入口命令 / 镜像问题（Exit Code 127）

镜像里缺少命令，或 `command`/`args` 写错。

```text
sh: 1: ./start.sh: not found
```

**排查：**

```bash
# 确认镜像里有没有这个文件
docker run --rm <image> ls -l /app
```

**解决方案：**

- 修正 `command`/`args`，注意工作目录 `workingDir`。
- 检查 Dockerfile 是否正确 `COPY` 了启动脚本并给了执行权限（`chmod +x`）。

### 3.4.4 探针失败导致反复重启

`livenessProbe` 探测失败会触发容器重启；如果探针本身配置不当，会出现"应用其实没问题但一直被杀"的假象。

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 5      # 初始延迟太短，应用还没起来
  periodSeconds: 10
  failureThreshold: 3
```

**现象**：`Events` 中出现 `Liveness probe failed: HTTP probe failed with statuscode: 500`。

**解决方案：**

- 调大 `initialDelaySeconds`，给应用足够的启动时间。
- 确认探针路径、端口、协议与真实健康检查实现一致。
- 区分 `livenessProbe`（失败=重启）与 `readinessProbe`（失败=摘流量），语义别搞反。

## 3.5 综合案例：Java 应用反复 OOMKilled

**场景**：一个 Spring Boot 应用部署后不断 `CrashLoopBackOff`，`describe` 显示 `OOMKilled`。

```bash
kubectl describe pod user-service-6f8b9d-xkqz | grep -A 5 "Last State"
```

排查步骤：

1. 确认 OOM：

```text
Last State: Terminated
  Reason: OOMKilled
  Exit Code: 137
```

2. 检查 Pod 资源限制：

```bash
kubectl get pod user-service-6f8b9d-xkqz -o yaml | grep -A 5 resources
# limits.memory: 512Mi
```

3. 检查 JVM 启动参数：

```text
java -Xms1g -Xmx1g -jar app.jar
```

**根因**：JVM `-Xmx1g` 远大于容器 `512Mi` 限制。JVM 认为可用内存是 1g，但容器 cgroup 只给 512Mi，一旦堆外内存（元空间、线程栈、直接内存）叠加，就会触发内核 OOM。

**解决**：

- 将 `-Xmx` 调小（如 `-Xmx384m`），并设置 `-XX:MaxRAMPercentage=75.0` 让 JVM 自适应容器限制。
- 或使用 `UseContainerSupport`（JDK 10+ 默认开启）感知 cgroup 限制。

## 3.6 章末小结

- `CrashLoopBackOff` 是现象不是原因，核心是看 `Exit Code` + `--previous` 日志。
- 高频根因排序：OOMKilled（137）、应用报错（1）、命令/镜像缺失（127）、探针误杀。
- 容器化语言运行时（尤其 JVM）务必让其感知 cgroup 内存限制。

---

# 第 4 章：Service 访问异常排障

## 4.1 Service 的工作原理

Service 是 K8s 的"服务发现"抽象，它把一组后端 Pod 聚合起来，对外提供稳定的虚拟 IP（ClusterIP）与端口。理解它的数据链路，是排障的前提：

```text
请求 → Service ClusterIP:Port
              ↓
         kube-proxy（iptables/IPVS）负载均衡
              ↓
        Endpoints / EndpointSlice（后端 Pod IP 列表）
              ↓
           Pod 的 targetPort
```

- **Endpoints / EndpointSlice**：由 Service 的 `selector` 动态维护，是"后端 Pod 的 IP:端口"集合。
- **kube-proxy**：把 Service 的虚拟 IP 转发到后端 Pod，实现负载均衡。
- **CoreDNS**：把 Service 名称解析为 ClusterIP。

> 关键认知：Service 只是一个"转发规则 + 名字"，它本身不转发数据。如果 Service 的 `selector` 匹配不到任何 Pod，Endpoints 就是空的，访问必然失败。

## 4.2 排查入口

```bash
# 同时查看 Service 和 Endpoints（一步到位）
kubectl get svc,endpoints -n <namespace>
```

```text
NAME          TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE
svc/web-app   ClusterIP   10.96.100.42    <none>        80/TCP     10m

NAME            ENDPOINTS           AGE
endpoints/web-app  10.244.1.5:8080   10m
```

**第一个关键判断**：`ENDPOINTS` 列是否为空。为空说明 Service 没有匹配到任何后端 Pod，问题出在"选择器"或"Pod 状态"；不为空则说明后端已就绪，问题可能在网络链路或端口映射。

## 4.3 常见原因与解决方案

### 4.3.1 Selector 不匹配，Endpoints 为空

这是最高频的原因。Service 的 `selector` 标签与 Pod 的 `labels` 不一致。

**排查：**

```bash
# 查看 Service 的 selector
kubectl get svc web-app -o yaml | grep -A 5 selector

# 查看 Pod 的 labels
kubectl get pods -n <namespace> --show-labels
```

**示例**：Service selector 写的是 `app: web-app`，但 Pod 的 label 是 `app: webapp`（少了连字符）。一字之差，Endpoints 全空。

**解决方案**：统一 `selector` 与 Pod `labels`。也可以反过来，通过 `kubectl get endpoints` 确认当前匹配到了哪些 Pod。

### 4.3.2 端口映射错误（port / targetPort）

Service 有两个端口概念：

- `port`：Service 对外暴露的端口（访问 ClusterIP 时用）。
- `targetPort`：后端 Pod 容器监听的端口。

**现象**：Endpoints 不为空，但访问 Service 端口报 `connection refused` 或超时。

**排查：**

```bash
# 确认 Pod 实际监听端口
kubectl exec -it <pod> -n <namespace> -- ss -lntp
```

**常见坑**：Pod 容器监听的是 `8080`，但 Service 的 `targetPort` 写成了 `80`，或者 `targetPort` 写了端口名但容器没定义该命名端口。

**解决方案**：让 `targetPort` 与容器真实监听端口一致；优先使用命名端口（`targetPort: http`）减少硬编码。

### 4.3.3 Pod 未 Ready

即使 Endpoints 有内容，但如果 Pod 的 `readinessProbe` 失败，Pod 会被从 Endpoints 中摘除（或从未加入）。

**排查：**

```bash
kubectl get pods -n <namespace>
# 关注 READY 列，如 0/1 表示未就绪

kubectl describe pod <pod> -n <namespace> | grep -A 5 "Conditions"
```

**解决方案**：先解决 Pod 的 `Ready` 问题（参考第 3 章 CrashLoopBackOff 排障）。

### 4.3.4 kube-proxy 故障

如果 Endpoints 正常但 Service 依然不通，可能是 kube-proxy 数据面出了问题。

**排查：**

```bash
# 查看 kube-proxy Pod 状态
kubectl get pods -n kube-system -l k8s-app=kube-proxy

# 查看 kube-proxy 日志
kubectl logs -n kube-system <kube-proxy-pod>
```

**解决方案**：重启异常 kube-proxy；检查节点 iptables/IPVS 规则是否被清空；确认 CNI 插件正常（kube-proxy 依赖节点网络）。

### 4.3.5 DNS 解析失败

Pod 之间通过 Service 名称访问（如 `http://web-app.default.svc`）时，依赖 CoreDNS 解析。若 DNS 出问题，表现为"名字解析不了"而非"连不上"。

**排查：**

```bash
# 进入 Pod 测试 DNS
kubectl exec -it <pod> -- nslookup web-app.default.svc.cluster.local

# 检查 CoreDNS
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns
```

**解决方案**：修复 CoreDNS；检查 `/etc/resolv.conf` 的 `ndots` 与 search 域配置。

## 4.4 综合案例：Service 能建通，但 Endpoints 一直为空

**场景**：新建 Deployment + Service 后，通过 Service 访问总是失败。

```bash
kubectl get svc,ep -n prod
# svc/order-api   ClusterIP   10.96.50.11   <none>   80/TCP    5m
# ep/order-api    <none>                            5m
```

排查步骤：

1. Endpoints 为空，优先怀疑 selector 不匹配：

```bash
kubectl get svc order-api -o yaml | grep -A 3 selector
#   selector:
#     app: order-api
#     tier: backend

kubectl get pods -l app=order-api,tier=backend -n prod
# No resources found
```

2. 查看 Pod 真实标签：

```bash
kubectl get pods -n prod --show-labels | grep order
# order-api-5d8c9f-xxx   app=order-api   version=v1
```

**根因**：Deployment 只打了 `app=order-api` 一个标签，而 Service 多写了 `tier: backend`，导致 selector 永远匹配不到。

**解决**：删除 Service 中多余的 `tier: backend` 条件，Endpoints 立即填充，访问恢复。

## 4.5 章末小结

- Service 排障第一步永远看 `ENDPOINTS` 是否为空。
- 空 → 查 `selector`、Pod `labels`、Pod `Ready`；非空 → 查端口映射、kube-proxy、DNS。
- 牢记 `port`（对外）与 `targetPort`（后端）的区别。

---

# 第 5 章：Ingress 访问异常排障

## 5.1 Ingress 的工作原理

Ingress 是七层（HTTP/HTTPS）入口，它把外部流量按域名 + 路径路由到后端 Service。数据链路比 Service 多了一层控制器：

```text
外部请求 → Ingress Controller（NGINX/Traefik/...）
              ↓  根据 Ingress 规则
        Service（后端服务）
              ↓
           Pod
```

- **Ingress Controller**：真正处理流量的组件（如 ingress-nginx），它是运行在集群里的 Pod。
- **Ingress 资源**：只声明"域名/路径 → 后端 Service"的路由规则。

> 关键认知：Ingress 只是"规则声明"，Ingress Controller 才是"执行者"。如果 Controller 没装、没生效，或者 `ingressClassName` 不匹配，规则再正确也不通。

## 5.2 排查入口

```bash
# 查看 Ingress 与后端
kubectl get ingress -n <namespace>
kubectl describe ingress <ingress-name> -n <namespace>

# 查看 Ingress Controller 状态
kubectl get pods -n ingress-nginx
kubectl logs -n ingress-nginx <controller-pod> --tail=50
```

`describe ingress` 的 `Rules` 与 `Backend` 段能直观看到路由规则是否解析正确。

## 5.3 常见原因与解决方案

### 5.3.1 Ingress Controller 未安装或未运行

这是"访问 404/无法连接"的最基础原因。

**排查：**

```bash
kubectl get pods -n ingress-nginx
# 如果为空或 Pod 异常，说明 Controller 有问题

kubectl get svc -n ingress-nginx
# 确认 Controller 暴露的 Service 类型（NodePort / LoadBalancer）
```

**解决方案**：正确部署 Ingress Controller（如 `kubectl apply -f ingress-nginx` manifest），并确认其 Service 暴露方式与访问地址一致。

### 5.3.2 ingressClassName 不匹配

K8s 1.18+ 引入了 `IngressClass` 机制。如果 Ingress 声明的 `ingressClassName` 与 Controller 不匹配，规则不会被任何 Controller 处理。

**排查：**

```bash
kubectl get ingressclass
# NAME           CONTROLLER                     PARAMETERS   AGE
# nginx          k8s.io/ingress-nginx           <none>       30d

kubectl get ingress <name> -o yaml | grep ingressClassName
```

**常见坑**：Ingress 里 `ingressClassName: nginx` 写错、或者老版本用 `kubernetes.io/ingress.class` 注解但 Controller 已升级为 `IngressClass`。

**解决方案**：统一 `ingressClassName`；检查 Controller 的 `--controller-class` 参数。

### 5.3.3 后端 Service 名称 / 端口错误

Ingress 的 `backend.service.name` 或 `port` 写错，会导致 503 Service Unavailable。

**排查：**

```bash
kubectl describe ingress <name> -n <namespace> | grep -A 10 Backend
```

**常见坑**：后端写的是 Service 的 `port`（对外端口）还是 `targetPort`（后端端口）搞混。Ingress 的后端端口应为 **Service 的 `port`**。

**解决方案**：核对后端 Service 名称是否存在于同一命名空间，端口是否为 Service 的 `port`。

### 5.3.4 TLS 证书问题

HTTPS 访问报证书错误，或 400 Bad Request。

**排查：**

```bash
kubectl get secret <tls-secret> -n <namespace>
kubectl describe ingress <name> -n <namespace> | grep -A 5 TLS
```

**常见坑**：

- Secret 不存在或命名空间不对。
- 证书过期或与域名不匹配。
- 证书格式不是 PEM（需为 `tls.crt` + `tls.key` 两个 key）。

**解决方案**：修正 Secret 引用、更新证书、确保域名在证书 SAN 列表中。

### 5.3.5 Path 规则与重写（rewrite）问题

访问路径返回 404，往往是 path 匹配或 rewrite 注解配置不当。

**排查：**

```bash
kubectl get ingress <name> -o yaml | grep -A 10 path
```

**常见坑**：

- 后端应用实际需要根路径 `/`，但 Ingress 把 `/api` 转发过去，应用返回 404。
- 缺少 `nginx.ingress.kubernetes.io/rewrite-target` 注解，导致路径未正确重写。

**解决方案**：合理配置 `path` 与 rewrite 注解，使转发到后端的路径与应用真实路由一致。

## 5.4 综合案例：Ingress 一直返回 404

**场景**：配置 Ingress 后，浏览器访问域名始终 404。

```bash
kubectl describe ingress web-ingress -n default
# Rules:
#   Host              Path    Backends
#   ----              ----    --------
#   app.example.com   /       web-svc:80 (10.244.2.9:8080)
```

排查步骤：

1. 后端 Backend 已正确解析（说明规则本身没问题），先验证 Controller 是否收到请求：

```bash
kubectl logs -n ingress-nginx <controller-pod> --tail=20 | grep app.example.com
```

2. 日志显示请求已到达，但被转发到 `web-svc:80` 后返回 404。说明问题在后端 Service 或应用：

```bash
kubectl get svc,endpoints -n default | grep web-svc
# web-svc   ClusterIP 10.96.70.1  <none>  80/TCP   5m
# web-svc   10.244.2.9:8080                       5m
```

3. 直接在集群内测试 Service：

```bash
kubectl run curl-test --rm -it --image=curlimages/curl -- sh
curl http://web-svc.default.svc.cluster.local:80/
# 返回 404
```

**根因**：后端应用监听的是 `8080` 端口且路由为 `/web`，但 Service 把对外 `port: 80` 映射到 `targetPort: 8080` 后，应用根路径 `/` 本身就没有路由（404）。同时 Ingress 未做路径重写。

**解决**：

- 给 Ingress 添加 rewrite 注解，将 `/` 重写为应用的 `/web`：

```yaml
annotations:
  nginx.ingress.kubernetes.io/rewrite-target: /web
```

- 或者调整应用路由，使根路径 `/` 可访问。

## 5.5 章末小结

- Ingress 排障先确认 Controller 是否运行、`ingressClassName` 是否匹配。
- 再看 `describe ingress` 的 Backend 是否正确指向 Service 的 `port`。
- 404 多与 path/rewrite 有关；503 多与后端 Service/Endpoints 有关；证书错误多与 TLS Secret 有关。

---

# 第 6 章：总结与排障工具链

## 6.1 四类问题排障速查

| 现象 | 首要判断 | 关键命令 | 高频根因 |
|------|---------|---------|---------|
| Pod Pending | 调度卡在哪 | `describe pod` 看 Events | 资源不足、污点/亲和性、PVC 未绑定 |
| CrashLoopBackOff | 退出码是多少 | `logs --previous` + `describe` Last State | OOMKilled、应用报错、命令缺失 |
| Service 不通 | Endpoints 是否为空 | `get svc,endpoints` | selector 不匹配、targetPort 错误 |
| Ingress 404/503 | Controller + Backend | `describe ingress` + Controller 日志 | ingressClass 不匹配、rewrite、后端端口 |

## 6.2 一条通用的排障链路

```text
kubectl get（看状态）
   ↓
kubectl describe（看事件/原因）
   ↓
kubectl logs --previous（看崩溃日志）
   ↓
kubectl exec（进容器实测）
   ↓
逐层定位（Pod → Service → Ingress → 外部）
```

## 6.3 排障辅助工具

- **kubectl describe/get -o yaml**：最基础的"现场取证"工具。
- **k9s / Lens**：可视化交互式排障，快速浏览 Pod 状态与日志。
- **stern**：多 Pod 日志聚合实时查看。
- **kubectl debug**：在不进入业务容器的情况下创建调试容器。
- **kubectl events / Events 排序**：按时间线还原"发生了什么"。

## 6.4 写在最后

Kubernetes 排障的本质，是**顺着资源对象的依赖链路逐层取证**：先确认"当前状态"，再追溯"状态背后的原因"，最后深入"容器的真实日志"。掌握了 Pending、CrashLoopBackOff、Service、Ingress 这四类最基础、最高频的排障套路，就掌握了应对绝大多数线上问题的入口。后续系列将深入网络（CNI）、存储（CSI）、控制面组件与性能优化的排障方法。

---

**系列导航**：

- 系列一（本文）：Pending / CrashLoopBackOff / Service / Ingress
- 系列二：网络（CNI / DNS / 连通性）排障
- 系列三：存储（PV/PVC/CSI）排障
- 系列四：控制面与性能排障
