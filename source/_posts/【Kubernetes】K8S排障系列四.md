---
title: Kubernetes 排障实战系列（四）：控制面与性能
date: 2026-10-08 23:00:00
categories: [Kubernetes]
tags: [Kubernetes, 排障, APIServer, etcd, kubelet, 性能优化, HPA]
---

# 第 1 章：控制面架构与请求链路

## 1.1 控制面组件全景

控制面是集群的"大脑"。它一旦变慢或不可用，故障会伪装成"Pod 起不来""Service 不通""节点 NotReady"等各种表象，迷惑性极强。

```text
┌───────────────────────────────────────────────────────────────┐
│                    控制面 Control Plane                        │
│                                                                │
│  ┌──────────────┐   ┌──────────────────┐   ┌───────────────┐  │
│  │ kube-apiserver│──│ kube-controller-  │──│ kube-         │  │
│  │  (无状态,可扩) │   manager           │   │ scheduler     │  │
│  └───────┬──────┘   └──────────────────┘   └───────────────┘  │
│          │ 唯一读写者                                           │
│          ↓                                                     │
│  ┌──────────────┐        静态 Pod（/etc/kubernetes/manifests）  │
│  │    etcd      │        由节点上的 kubelet 直接托管             │
│  │  (有状态,3/5) │        → containerd → 容器进程                │
│  └──────────────┘                                               │
└───────────────────────────────────────────────────────────────┘
          ↑ watch / 心跳上报
┌───────────────────────────────────────────────────────────────┐
│  节点侧：kubelet（每节点）+ kube-proxy（每节点）+ CNI/CSI        │
└───────────────────────────────────────────────────────────────┘
```

**关键关系**：

1. **只有 apiserver 直接读写 etcd**，其他组件全部通过 apiserver 交互。
2. apiserver 无状态，可水平扩展做多副本 + LB。
3. etcd 是有状态多数派，奇数节点（3/5），依赖磁盘与网络稳定性。
4. controller-manager / scheduler 多副本时靠**选主（leader election）**，只有 leader 真正工作。
5. kubelet 与 apiserver 之间是"心跳 + watch"，一旦上报中断，节点被标记 NotReady。

## 1.2 一次 kubectl 操作的完整链路

```text
kubectl apply -f deploy.yaml
   ↓ TLS + 认证(authn) → 鉴权(authz: RBAC) → 准入(admission: webhook/内置)
kube-apiserver
   ↓ 校验/默认值/转换
etcd  ← 写入（quorum 提交，需多数派可用）
   ↓ apiserver watch 广播
kube-controller-manager → 创建 ReplicaSet → 创建 Pod
   ↓
kube-scheduler → 绑定 Pod 到 Node
   ↓
目标节点 kubelet → CRI 拉镜像/创建容器 → 上报状态
```

排障时"卡在哪一步"直接决定责任人：

| 卡点 | 现象 | 归属组件 |
|------|------|---------|
| apply 就报错/超时 | `connection refused`、证书错误 | apiserver / 网络 / 证书 |
| apply 成功但对象未生效 | 无事件产生 | etcd / 控制器选主异常 |
| Pod 一直没创建 | Deployment 无 RS | controller-manager |
| Pod 存在但 Pending | `FailedScheduling` | scheduler / 资源 |
| Pod 创建后容器起不来 | kubelet 事件 | kubelet / CRI / CNI / CSI |

## 1.3 控制面健康第一步

```bash
# 组件健康（1.19+ componentstatuses 已废弃，仅作历史参考）
kubectl get --raw='/readyz?verbose'
kubectl get --raw='/healthz'

# 静态 Pod 是否都在跑
kubectl get pods -n kube-system -o wide | grep -E "apiserver|etcd|controller|scheduler"

# 节点侧直接确认进程与端口
ps -ef | grep kube-apiserver
ss -lntp | grep -E "6443|2379|2380"
```

## 1.4 控制面日志定位

```bash
# 静态 Pod 日志：通过 crictl 或容器日志文件
crictl ps | grep kube-apiserver
crictl logs <container-id> | grep -Ei "error|fail|timeout|refused" | tail -100

# journalctl（当组件以 systemd 方式部署时）
journalctl -u kubelet --since "10 min ago" | grep -iE "PLEG|not ready|NodeStatus"
```

> 经验法则：控制面日志里最有价值的关键词是 `timeout`、`etcdserver: request timed out`、`was refused`、`too many requests`、`context deadline exceeded`。

## 1.5 章末小结

- 控制面排障的第一步不是"查日志"，而是"确认卡点在哪一层"。
- 只有 apiserver 读写 etcd；apiserver 挂 = 整个集群"失联但仍在跑"。
- 静态 Pod 由 kubelet 直管，控制面故障常常是节点 kubelet/CRI 故障的伪装。

---

# 第 2 章：API Server 排障

## 2.1 API Server 不响应 / 超时

**现象：**

```text
error: Get "https://<apiserver>:6443/apis/apps/v1/namespaces/default/deployments":
  context deadline exceeded
```

**排查顺序：**

```bash
# 1. 进程与端口还在吗
ss -lntp | grep 6443

# 2. 后端 etcd 是否健康（apiserver 超时的第一嫌疑）
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key endpoint health

# 3. 证书是否过期（apiserver/kubelet 客户端证书有效期 1 年）
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -enddate -noout

# 4. 资源是否被打满（CPU/mem/fd）
pid=$(pgrep kube-apiserver)
cat /proc/$pid/limits | grep "open files"
ss -s
```

## 2.2 请求限流与 max-in-flight

apiserver 对每个客户端有并发上限，超限直接返回 `429 Too Many Requests`：

```bash
# 客户端看到
kubectl get pods
# error: You must be logged in to the server (Unauthorized)
# 或 "Timeout while waiting for a server response" / "too many requests"
```

apiserver 关键参数：

| 参数 | 默认 | 作用 |
|------|------|------|
| `--max-requests-inflight` | 400 | 非读请求（Mutating）并发上限 |
| `--max-mutating-requests-inflight` | 200 | 读请求并发上限 |
| `--request-timeout` | 60s | 单请求最长按 |

**定位思路：**

1. 看指标：APIServer 的请求延迟 P99 与并发数。

```bash
kubectl get --raw /metrics | grep -E "apiserver_request_total|rest_client_requests_total" \
  | awk '{print $1}' | grep -E 'code="429"|code="500"' | tail -20
```

2. 看谁在刷：按 UA（User-Agent）统计：

```bash
grep -E "GET|LIST" /var/log/kubernetes/apiserver.log \
  | awk '{print $NF}' | sort | uniq -c | sort -rn | head
```

**处置：**

- 限制问题组件（最常见：某个 Operator 每分钟 `list` 全集群 Pod，或某监控 exporter 未使用 informer 缓存而做全量 LIST）。
- 开启 **APF（API Priority and Fairness，1.20+ 默认）**：为不同 workload 建 `PriorityLevelConfiguration`，保护核心组件不被刷垮。
- 调大 `max-requests-inflight` 只是止痛，优先做客户端治理。

## 2.3 Admission Webhook 阻塞导致"集群只读"

这是控制面最危险的一类故障：某个 `MutatingWebhookConfiguration` 后端挂了，且 `failurePolicy: Fail`，结果**所有资源写入全部超时失败**，但读请求完全正常。

**现象：**

```text
Error from server: error when creating "app.yaml":
  admission webhook "mutate.example.com" denied the request:
  Post https://mutator.ns.svc:443/mutate: context deadline exceeded
```

**排查与处置：**

```bash
# 1. 找出所有 webhook
kubectl get mutatingwebhookconfigurations
kubectl get validatingwebhookconfigurations

# 2. 看 scope 是否过宽（rules: "*" + operations: "*,CREATE..." 是危险配置）
kubectl get mwc <name> -o jsonpath='{.webhooks[*].failurePolicy}{"\n"}{.webhooks[*].rules}{"\n"}{.webhooks[*].matchPolicy}'

# 3. 应急：直接把失败策略改成 Ignore 或临时删掉配置（保留声明以便恢复）
kubectl patch mwc <name> -p '{"webhooks":[{"name":"<hook-name>","failurePolicy":"Ignore"}]}'
```

> 安全铁律：任何"集群无法 apply"的故障，**先怀疑 webhook**，因为它是少数能全局阻断控制面的扩展点。生产集群部署 mutator 必须 `failurePolicy: Ignore`（非关键场景）并配置 namespace 排除。

**预防：**

```yaml
# 关键排除：绝不能让 webhook 拦截 kube-system 与自身命名空间
namespaceSelector:
  matchExpressions:
  - key: kubernetes.io/metadata.name
    operator: NotIn
    values: [kube-system, gatekeeper-system, kube-node-lease]
objectSelector:
  matchExpressions:
  - key: admission-webhook/disabled
    operator: NotIn
    values: ["true"]
```

## 2.4 大对象与事件风暴

apiserver 默认对象大小限制约 1.5MB，etcd 默认配额 2GB。常见故障源：

1. **ConfigMap/Secret 超大**（如塞入整套证书链或数据文件）→ 写入 `request too large`，且 watch 传输风暴。
2. **一个 Service 挂了上万 Endpoints**（v1.21 前无 EndpointSlice）→ 每次更新触发巨型对象重传，apiserver CPU 飙升。
3. **Event 洪泛**：某 Pod 反复重启每秒产生 Event，`--event-ttl` 内堆积巨量小对象写。

```bash
kubectl get --raw '/api/v1/namespaces/<ns>/configmaps' | wc -c
kubectl get events -A --sort-by=.lastTimestamp | tail -50
```

## 2.5 性能剖析：pprof

```bash
# 需要管理员权限，走 apiserver 的 proxy 或端口转发
kubectl -n kube-system port-forward pod/kube-apiserver-<node> 8001:8001
go tool pprof -http=:8080 http://localhost:8001/debug/pprof/profile?seconds=30
```

`heap` 看内存分配热点，`profile` 看 CPU。典型结论：大量 LIST 解码、json 序列化、或某个 informer 缓存泄漏。

## 2.6 综合案例：集群"能读不能写"，Pod 一律无法部署

**场景**：监控告警"控制面延迟上升"，随后所有 `kubectl apply` 卡住 30 秒报错，但 `get`、`logs`、`exec` 全部正常。

排查步骤：

1. 读正常、写失败 → 指向准入阶段（webhook 只拦截写操作）。

```bash
kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations
# policy-webhook   1 hook   <unknown>
```

2. 检查该 webhook 后端是否运行：

```bash
kubectl -n policy-system get pods
# policy-engine-0   Pending    ← 它自己无法被调度，因为 apply 已被自己的 webhook 阻断
```

3. 查看 webhook 配置：

```bash
kubectl get mwc policy-webhook -o jsonpath='{.webhooks[0].failurePolicy}'
# Fail
kubectl get mwc policy-webhook -o jsonpath='{.webhooks[0].clientConfig}'
# {"url":"https://policy-engine.policy-system.svc:9443/mutate"}
```

**根因**：策略引擎 Pod 因节点资源不足被驱逐 → webhook 后端不可达 → `failurePolicy: Fail` 使所有写操作超时 → 而"恢复它所需的 apply 操作"本身也被阻断，形成**自锁死循环**。

**解决**：

1. 临时删除该 webhook 配置（备份 YAML 后 `kubectl delete`），集群立刻恢复写入。
2. 扩容节点并重新部署策略引擎。
3. 长期改进：为策略引擎配 `PriorityClass: system-cluster-critical` + 专用节点 + `failurePolicy: Ignore`，并把 `policy-system` 命名空间加入 `namespaceSelector` 排除。

> 教训：**任何控制面扩展点都不能依赖被它控制的通道来自愈**。准入 webhook 必须有旁路（排除自身命名空间）与降级策略。

## 2.7 章末小结

- "能读不能写" ≈ 准入 webhook；"读写都慢" ≈ etcd 或资源瓶颈；"全挂" ≈ 证书/网络/进程。
- 429 与请求风暴是规模化集群的头号性能杀手，治理客户端优先于调大参数。
- pprof + metrics 让你不再靠猜。

---

# 第 3 章：etcd 排障

## 3.1 etcd 的角色与拓扑

```text
┌─────────────────────────────────────────────────────────────┐
│  etcd cluster (3 或 5 节点，Raft 多数派)                      │
│                                                              │
│  leader ──── follower ──── follower                          │
│     ↓            ↓            ↓                              │
│  WAL: /var/lib/etcd  (fsync 每笔写)  +  backend (bbolt)      │
└─────────────────────────────────────────────────────────────┘
```

- **多数派可用**才可写：3 节点容忍 1 挂，5 节点容忍 2 挂。
- 每个写请求都要 `fsync` 到磁盘，**磁盘延迟直接等于控制面延迟**。

## 3.2 常用运维命令

```bash
alias etcdctl='ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key'

etcdctl endpoint health --cluster -w table
etcdctl endpoint status --cluster -w table   # dbSize / leader / raftTerm
etcdctl member list -w table
etcdctl alarm list
```

## 3.3 案例：NOSPACE 告警导致集群只读

**现象**：控制面所有写操作失败，apiserver 日志报：

```text
etcdserver: mvcc: database space exceeded
```

```bash
etcdctl alarm list
# 2025-01-01 ... NOSTATE alarm:NOSPACE
etcdctl endpoint status -w table | head
# ... 8GB / 8GB (配额已用满)
```

**根因链**：默认 `--quota-backend-bytes=2GB`；某个 Operator 每分钟创建/删除大量 Event 或频繁更新巨型 CRD，revision 膨胀 + 未压缩 + 未碎片整理 → dbSize 打满 → 触发 NOSPACE 告警 → etcd 进入只读保护。

**处置步骤（顺序不能错）：**

```bash
# 1. 备份！先备份再动手
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F-%H%M).db
etcdctl snapshot status /backup/etcd-xxx.db -w table

# 2. 压缩历史版本（把 revision 收敛到最新）
etcdctl compact $(etcdctl endpoint status --write-out="json" \
  | jq '.[0].Status.header.revision')

# 3. 碎片整理，真正释放磁盘空间（会短暂阻塞该 member，逐个做）
for ep in https://10.0.0.1:2379 https://10.0.0.2:2379 https://10.0.0.3:2379; do
  ETCDCTL_API=3 etcdctl --endpoints=$ep defrag
done

# 4. 解除告警（不做这一步，只读状态不会自动恢复！）
etcdctl alarm disarm

# 5. 验证
etcdctl endpoint health --cluster
```

> 关键坑：`defrag` 后必须 `alarm disarm`，否则集群仍然只读。这是最常见的"明明处理完还是不能写"。

**预防：**

```yaml
# 自动压缩（Kubernetes 侧或 etcd 侧二选一，etcd 1.30+ 支持内置自动压缩）
--auto-compaction-mode=periodic --auto-compaction-retention=1h
--quota-backend-bytes=8589934592   # 8GB，同时保证磁盘容量 > 2 倍配额
```

- 应用侧禁止频繁更新巨型对象、禁止把 etcd 当队列用。
- 监控 `etcd_server_has_leader`、`etcd_disk_wal_fsync_duration_seconds`、`etcd_mvcc_db_total_size_in_use_in_bytes`。

## 3.4 慢盘：控制面延迟的隐形来源

etcd 对磁盘延迟极其敏感。官方阈值参考：

```text
wal_fsync_duration_seconds P99  < 10ms   （良好）
                            > 50ms  → 集群不稳定
```

**排查：**

```bash
# 直接压测数据盘
fio --name=etcd-fsync --rw=write --bs=2304k --size=128M --fsync=1 --direct=1 \
    --filename=/var/lib/etcd/fio.test --runtime=30

# 指标
kubectl get --raw /metrics | grep wal_fsync_duration_seconds_bucket
```

**典型根因**：

- 控制面节点与业务节点混用同一块盘，业务日志/镜像 IO 抢占 IO 队列。
- 网络存储（NAS/云盘低规格）承载 etcd 数据。
- 其他进程独占 CPU 导致 etcd 的 fsync 线程饥饿。

**处置**：控制面独占 SSD 本地盘；关闭 swap；`--election-timeout` / `--heartbeat-interval` 根据实际延迟调大（跨地域场景）。

## 3.5 Leader 频繁切换

```bash
etcdctl endpoint status -w table      # 看 leader 是否反复变
journalctl -u etcd | grep -iE "leader|election|lost"
```

常见根因与处置：

| 现象 | 根因 | 处置 |
|------|------|------|
| 跨 AZ / 跨地域部署 | RTT 高 | 提高 `heartbeat-interval`(如 300ms) 与 `election-timeout`(3000ms) |
| 某 member 磁盘慢 | fsync 超时 | 换盘、或临时 `etcdctl move-leader` |
| 网络抖动 | 丢包/防火墙 | 修复链路，检查 `--listen-peer-urls` 端口 2380 互通 |
| 时钟漂移 | NTP 未同步 | 恢复 chrony，节点时间必须一致 |

```bash
etcdctl move-leader <target-member-id>
```

## 3.6 备份与恢复

**备份（必须定时 + 异地）：**

```bash
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F-%H-%M).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=... --cert=... --key=...
etcdctl snapshot status /backup/xxx.db
```

**恢复（kubeadm 集群）：**

```bash
# 1. 停 kubelet，避免恢复期间被写
systemctl stop kubelet

# 2. 从快照恢复数据目录
etcdctl snapshot restore /backup/etcd-xxx.db \
  --data-dir=/var/lib/etcd-restore \
  --initial-cluster=master-0=https://10.0.0.1:2380,master-1=https://10.0.0.2:2380 \
  --initial-cluster-token=etcd-restore \
  --initial-advertise-peer-urls=https://10.0.0.1:2380

# 3. 修改 etcd 静态 Pod 的 --data-dir 指向恢复目录，先单机拉起，再扩回集群
# 4. 验证 kubectl 与关键资源，再逐个 master 恢复
```

> 铁律：**恢复演练要定期做**。快照的价值只在"能恢复"，而不是"存在"。至少季度演练一次全量恢复，并记录耗时。

## 3.7 章末小结

- etcd 三种典型故障：**配额满（只读）、慢盘（延迟）、网络/时钟（切主）**。
- 处理顺序永远是：备份 → 定位 → compact/defrag → alarm disarm → 验证。
- 控制面磁盘独立 + 自动压缩 + 定时快照，是 etcd 稳定的三根支柱。

---

# 第 4 章：调度器与控制器管理器排障

## 4.1 组件的"选主"本质

controller-manager 与 scheduler 多副本时，**只有 leader 干活**：

```bash
kubectl -n kube-system get leases \
  -o custom-columns=NAME:.metadata.name,HOLDER:.spec.holderIdentity,RENEW:.spec.renewTime
```

```text
NAME                    HOLDER                    RENEWTIME
kube-scheduler          master-1_abc123           2026-10-08T12:00:02Z
kube-controller-manager master-2_def456           2026-10-08T12:00:01Z
```

**判读**：`renewTime` 停止刷新（一般 10s 一次）→ leader 已挂或无法访问 apiserver → 相关功能（调度、Endpoint 更新、PV 绑定）全部停摆。

## 4.2 调度器排障

**现象**：Pod 长时间 Pending 但 `FailedScheduling` 事件并不明显，且 `kubectl describe pod` 显示没有任何事件。

```bash
# 1. scheduler 是否在跑
kubectl -n kube-system get pods -l component=kube-scheduler
kubectl -n kube-system logs -l component=kube-scheduler --tail=100

# 2. leader lease 是否新鲜（见 4.1）
# 3. 队列积压指标
kubectl get --raw /metrics | grep scheduler_pending_pods
```

| 指标 | 含义 | 告警线参考 |
|------|------|-----------|
| `scheduler_pending_pods{queue="active"}` | 活跃队列积压 | 持续增长 > 100 |
| `scheduler_pending_pods{queue="backoff"}` | 退避队列（重试失败） | 大量堆积 = 调度反复失败 |
| `scheduler_e2e_scheduling_duration_seconds` | 单 Pod 调度耗时 P99 | > 1s 需关注 |
| `scheduler_scheduling_attempt_duration_seconds` | 每次尝试（含抢占）耗时 | 抢占风暴时飙升 |

**常见根因：**

1. **大规模集群 + 细粒度打分**：filter/score 阶段遍历全部节点耗时。启用 `percentageOfNodesToScore`（默认自适应约 25%）。
2. **抢占风暴**：PriorityClass 滥用导致大量 Pod 抢占重排。
3. **自定义插件（Scheduler Framework）阻塞**：webhook 型调度器扩展点同步调用外部服务，把调度拖慢。
4. **多调度器共存**：Pod 的 `schedulerName` 写错，落在无人处理的队列里。

## 4.3 Controller-Manager 排障（含 CSRM 限流）

controller-manager 负责 Node、Service、Endpoint、PV、Job、Deployment 等几十个大回路。

```bash
kubectl -n kube-system logs -l component=kube-controller-manager --tail=200 \
  | grep -iE "error|refused|throttl|timeout"
```

**kube-controller-manager 的关键限流参数：**

| 参数 | 默认 | 作用 | 风险 |
|------|------|------|------|
| `--kube-api-qps` | 20 | 请求 apiserver 的速率 | 集群大时过低导致控制器"慢半拍" |
| `--kube-api-burst` | 30 | 突发量 | 同上 |
| `--node-monitor-grace-period` | 40s | 判定节点失联的时间 | 过短会误判 NotReady 并触发驱逐 |
| `--pod-eviction-timeout`（旧）/TaintBasedEviction | 5m | 失联节点 Pod 驱逐 | 影响"卡住卷"（见系列三） |
| `--concurrent-*-syncs` | 各回路 5~50 | 并发 worker 数 | 大规模 Deployment/Endpoints 时是瓶颈 |

**典型故障：控制器队列阻塞**

现象是"Service 后端变了但 Endpoints 迟迟不更新"，排查：

```bash
kubectl get --raw /metrics | grep workqueue_depth
# workqueue_depth{name="endpoint_controller"} 12000  ← 严重积压
```

处置：调大 `--concurrent-endpoint-syncs`、提高 `--kube-api-qps/burst`，或把 EndpointSlice 启用（v1.21+，大幅降低对象体积与更新频率）。

## 4.4 综合案例：节点大批 NotReady 且恢复后反复横跳

**场景**：某晚高峰，5 个节点同时 `NotReady`，Pod 被大量驱逐，业务抖动；过几分钟节点又自动 Ready，如此反复。

排查步骤：

1. 节点状态与条件：

```bash
kubectl describe node <node> | grep -A 8 Conditions
# Ready=False, reason: NodeStatusUnknown, lastHeartbeatTime: 3 hours ago
```

2. kubelet 日志显示心跳发送失败：

```bash
journalctl -u kubelet | grep -iE "node status|PatchNodeStatus|429|timeout"
# Patch "nodes/xxx": 429 Too Many Requests
```

3. 定位 429 来源：apiserver 的 APF 把 `system:nodes` 优先级挤到了共享桶里，或被其他组件的写风暴淹没。

```bash
kubectl get --raw /metrics | grep -E 'apiserver_flowcontrol_rejected_requests_total' | head
```

**根因**：某 Operator 在高峰期以极高频率 `PATCH` 各自 CR 状态，触发写请求饱和；`system:nodes` 心跳上报被排队限流，超时后节点被判 NotReady，控制器随即开始驱逐 Pod，制造更多写入 → 正反馈放大。

**解决**：

1. 立即：用 APF 为 `system:nodes` 建独立 `PriorityLevelConfiguration`，保证心跳带宽；临时冻结问题 Operator。
2. 中期：调大 `--node-monitor-grace-period` 到 60s，避免瞬时抖动误判驱逐。
3. 长期：Operator 侧改为 informer + 增量更新，禁止全量 reconcile；控制面写 QPS 纳入告警。

> 教训：**"节点故障"常常不是节点故障**，而是心跳通道被挤占。看 `lastHeartbeatTime` 是否滞后、kubelet 是否收到 429，是区分二者的关键。

## 4.5 章末小结

- 控制面组件多副本 ≠ 都在工作：先看 lease。
- 调度与控制器"变慢"的定位利器是 `workqueue_depth` 与 `scheduler_pending_pods`。
- 节点 NotReady 要区分"真的挂了"与"心跳被限流"，处置方式完全不同。

---

# 第 5 章：kubelet 与节点层排障

## 5.1 节点 NotReady 的三种判定路径

kubelet 通过周期性上报 `NodeStatus` 维持 Ready。判 NotReady 的常见原因：

| Conditions 报错 | 真实含义 | 首查 |
|----------------|---------|------|
| `NodeStatusUnknown` | 心跳丢失（kubelet 挂了/网络断/被限流） | 节点上 `systemctl status kubelet`、apiserver 侧 429 |
| `KubeletNotReady ... PLEG is not healthy` | 容器运行时响应慢，PLEG 卡住 | containerd/dockershim 状态、大量僵尸容器 |
| `MemoryPressure` / `DiskPressure` / `PIDPressure` | 资源驱逐阈值触发 | `df -h`、`free -m`、`ps -eLf | wc -l` |
| `CNI not ready` / `NetworkUnavailable=True` | 网络插件未初始化 | CNI Pod 状态、`/etc/cni/net.d` 配置 |
| `cgroups ms mismatch` | cgroup 驱动不一致（systemd vs cgroupfs） | kubelet 与运行时的 cgroupDriver |

## 5.2 PLEG 不健康：最高频的 kubelet 故障

```text
E1008 kubelet: "PLEG is not healthy: pleg was last seen active 3m2s ago; threshold is 3m0s"
```

PLEG（Prometheus Linux Event Generator）负责监听容器生命周期事件。当它卡住，kubelet 无法上报状态，节点直接 NotReady。

**根因清单：**

```bash
# 1. 运行时进程是否响应
crictl version && crictl ps -a | wc -l

# 2. 容器数量过多 / 大量已退出容器未清理（最常见）
crictl ps -a --state= exited | wc -l
# 处置：调低 imageGCHighThresholdPercent / 清理僵尸容器
systemctl restart containerd    # 最后手段

# 3. 运行时被 IO 阻塞（日志盘满、镜像层解压慢）
iostat -x 1 3

# 4. 内核 cgroup / overlayfs 泄漏导致 stat 极慢
cat /sys/fs/cgroup/cpu.stat; dmesg | grep -i "hung task"
```

**处置：**

```bash
# 清理死容器 + 镜像垃圾
crictl rmi --prune
systemctl restart containerd kubelet

# 配置层修复（kubelet）
serializeImagePulls: false        # 并发拉镜像（含 token 限流场景慎用）
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
```

## 5.3 驱逐（Eviction）异常

```bash
kubectl describe node <node> | grep -A 6 "Allocated resources"
journalctl -u kubelet | grep -i "evict"
```

节点主动驱逐 Pod 会打印 `The node was low on resource: [NodeMemoryPressure]`。

**避坑要点：**

1. **内存 limit 总和超卖**：requests 低、limits 高，节点内存真实打满时由内核 OOM Killer 先动手（不可控），而不是 kubelet 驱逐（可控）。生产建议 limit 总和不超过节点可分配 2~3 倍，重要服务 requests 贴近实际。
2. `--system-reserved` / `--kube-reserved` 未设置 → 系统进程与 kubelet 被挤压 → 节点雪崩。
3. `--eviction-hard: memory.available<500Mi` 太激进会造成"抖动式驱逐"。

## 5.4 容器镜像拉取失败

```text
ErrImagePull / ImagePullBackOff
```

```bash
# 手动在节点验证（绕开 K8s）
crictl pull registry.example.com/app:v1
```

| Message 片段 | 根因 |
|-------------|------|
| `manifest unknown` | tag 写错 |
| `unauthorized: authentication required` | imagePullSecrets 缺失/过期 |
| `no such host` | 域名解析（DNS）问题 |
| `tls: failed to verify certificate` | 私有仓库证书未配置到 `containerd/certs.d` |
| `net/http: request canceled` | 到仓库网络不通（安全组/DNS/带宽） |
| `toomanyrequests: You have reached your pull rate limit` | Docker Hub 限流，需镜像搬运 |

> 经验：`ImagePullBackOff` 的"根因文本"就在 `describe pod` 的 Events 里，不需要猜；若显示 `pull QPS exceeded`，是仓库限流而非配置问题。

## 5.5 cgroup 驱动不一致

新装集群节点加入失败或容器莫名 OOM：

```bash
grep cgroupDriver /var/lib/kubelet/config.yaml
# cgroupDriver: systemd
cat /etc/containerd/config.toml | grep SystemdCgroup
# SystemdCgroup = true  ← 两者必须一致
```

## 5.6 综合案例：凌晨整点出现批量 Pod 重启

**场景**：每天 00:00 前后约 10% Pod 重启或 OOM，白天正常。

排查步骤：

1. 节点资源曲线（Prometheus）显示 00:00 内存骤降，伴随大量 Pod 被 OOMKill。
2. `journalctl` 显示内核 OOM 记录：

```text
Out of memory: Killed process 12345 (java) total-vm:... anon-rss:...
```

3. 定位是谁吃内存：

```bash
ps aux --sort=-%mem | head
```

发现某个备份 CronJob 每天 00:00 启动，`requests: 500Mi`，`limits: 1Gi`，实际使用 15Gi 备份任务把节点内存吃穿。

**根因**：备份 CronJob 未设 `nodeAffinity`/独立节点池，且 requests 严重低估真实用量（调度器按 500Mi 认为它很轻，实际吃 15Gi）。

**解决**：

- 备份任务固定调度到专用"批处理节点池"（`nodeSelector` + `tolerations`）。
- `requests` 按真实峰值设置（宁可多报），给 kubelet 正确的驱逐判断依据。
- 重要业务加 `PriorityClass`，保证被驱逐时优先保留。

> 教训：**requests 是调度与驱逐的预算依据**，严重低估等于"骗过"了控制面。定时任务/离线任务必须隔离到专属资源池。

## 5.7 章末小结

- NotReady 先分类："心跳丢了"还是"条件报错"——前者查 kubelet/网络/限流，后者看 Conditions 原因。
- PLEG 不健康的核心是运行时被拖慢，绝大多数与"容器/镜像堆积 + 磁盘 IO"有关。
- requests 写得太低会让驱逐决策失灵，这是资源型故障的常见根因。

---

# 第 6 章：性能与容量排障

## 6.1 控制面性能基线（先知道"正常"是什么样）

| 指标 | 健康参考 | 危险信号 |
|------|---------|---------|
| apiserver 请求延迟 P99（写） | < 1s | > 5s |
| `etcd_disk_wal_fsync_duration_seconds` P99 | < 10ms | > 50ms |
| `etcd_server_has_leader` | 1 | 0 |
| `apiserver_storage_objects` | < 100 万 | 接近 etcd 容量上限 |
| `scheduler_pending_pods` | < 10 | 持续增长 |
| `workqueue_depth` | < 100 | 数千 |
| `cluster_quantum: 单 namespace 对象数` | < 1 万 | Event/ConfigMap 洪泛 |
| 单集群对象总量（经验） | < 10 万 | 需要分片集群 |

## 6.2 HPA 排障：扩不上去 / 乱扩

```bash
kubectl get hpa <name> -n <ns>
# NAME     REFERENCE        TARGETS   MINPODS   MAXPODS   REPLICAS   AGE
# web-hpa  Deployment/web   <unknown>/80%   2    10    2    5m
```

`<unknown>` 表示指标不可用，直接看 conditions：

```bash
kubectl describe hpa web-hpa | grep -A 10 Conditions
# Reason: FailedGetResourceMetric
# Message: did not receive metrics for pod "web-xxx"
```

**常见根因：**

| Conditions.Reason | 含义 | 处置 |
|-------------------|------|------|
| `FailedGetResourceMetric` | metrics-server 无数据 | 检查 metrics-server / `kubectl top pods` |
| `FailedComputeReplicas` | CPU 低于 requests（指标为 0） | requests 太高或应用启动即空闲 |
| `ScalingDisabled` | `min == max` 或 paused | 调整范围 |
| `ScalingActive` | 正在扩缩 | 正常 |
| `StableWindow`/`DownscaleStabilization` | 缩容抑制期 | 正常（默认 5min） |

```bash
kubectl -n kube-system get pods -l k8s-app=metrics-server
kubectl top pods -n <ns>          # 若报错，HPA 必然异常
```

**行为优化：**

```yaml
behavior:
  scaleDown:
    stabilizationWindowSeconds: 300
    policies:
    - type: Percent
      value: 25
      periodSeconds: 60
  scaleUp:
    stabilizationWindowSeconds: 30
    policies:
    - type: Pods
      value: 4
      periodSeconds: 60
```

> 常见误区：`requests` 设得远小于真实用量，CPU 使用率指标虚高 → HPA 疯狂扩容。HPA 的指标是**相对 requests 的百分比**，所以 requests 必须反映真实基线。

## 6.3 冷启动与伸缩延迟

伸缩慢通常不是 HPA 慢，而是后续链路慢：

```text
HPA 决策(≈15s 采集周期) → RS 扩容 → 调度(≈1s) → 镜像拉取(可达分钟级) → 容器启动 → readiness 通过
```

**优化：**

```bash
# 镜像拉取是最大头：预拉取 + 镜像分层 + 同 AZ 仓库
kubectl get events -n <ns> --sort-by=.lastTimestamp | grep -E "Pulled|Created|Started"
```

- Cluster Autoscaler 场景要加 `--expander`、`priority` 与**扩容预留节点**（buffer node / over-provision Pod）。
- 大镜像用 `kubectl get events` 统计 `Pulling → Pulled` 差值定位瓶颈。

## 6.4 大规模集群的分片策略

单集群容量有限，接近上限时的正确解法不是"调参数"，而是"拆"：

```text
┌────────────────────────────────────────────────────┐
│  集群分片维度（任一维度触顶就拆）                     │
│  · 对象总数（apiserver_storage_objects）             │
│  · 节点数（controller-manager 各回路 sync 能力）      │
│  · namespace 数 / 单 ns 对象数                       │
│  · Event 与 metrics 基数（监控成本）                 │
│  · 爆炸半径（一个集群故障影响哪些业务）               │
└────────────────────────────────────────────────────┘
```

实践：按业务线/环境拆分多集群 + GitOps 统一管控；控制面独立节点池（至少 3 台高配 SSD）；etcd 数据盘独占。

## 6.5 综合案例：一次发布让集群 LIST 请求暴涨 30 倍

**场景**：升级某 Operator 后，apiserver CPU 从 30% 涨到 95%，节点上所有组件响应变慢。

排查步骤：

1. 按 UA 统计请求来源：

```bash
kubectl get --raw /metrics | grep apiserver_request_total \
  | grep -E 'verb="LIST"' | sort -t'"' -k4 | tail -20
```

发现 `user_agent="my-operator/v0.3"` 对 `pods` 全集群 LIST 每分钟数百次。

2. 确认无 labelSelector：

```bash
grep -r "client.List(ctx, &corev1.PodList{}" ./pkg/   # 无过滤条件
```

**根因**：新版 Operator 把带缓存的 informer 客户端换成了直连 client，每次 reconcile 全量 LIST，且 reconcile 频率为 30 秒。

**解决**：

- 回滚 + 修复客户端：使用 `manager.New(...)` 默认的带缓存 client，或加 `client.MatchingLabels`。
- 加 APF 隔离：为 Operator 建 `PriorityLevelConfiguration`，限制 `HandfulOfOperators` 桶容量，保护 `system:nodes` / `kube-system`。
- 治理制度化：CI 里扫描 `List(` 调用与无 selector 的用法。

> 教训：**规模化集群最大的性能敌人是"全量 LIST"**。客户端行为治理比服务端调参有效得多。

## 6.6 章末小结

- 性能问题必须有基线对照，没有指标就没有排障。
- HPA 异常九成是指标链路（metrics-server）或 requests 设置问题。
- 容量到顶时，先拆集群，别硬撑控制面参数。

---

# 第 7 章：总结 - 控制面排障工具箱与预防体系

## 7.1 控制面/性能问题定位速查表

| 现象 | 首要判断 | 关键命令 | 高频根因 |
|------|---------|---------|---------|
| 能读不能写 | 准入 webhook | `get mwc,vwc` + 后端 Pod 状态 | `failurePolicy: Fail` 且后端不可用 |
| 读写都超时 | etcd / 慢盘 | `etcdctl endpoint health`、`wal_fsync` | 磁盘 IO 或 NOSPACE |
| 集群不可访问 | 证书 / 进程 | `openssl x509 -enddate`、`ss -lntp` | 证书过期、apiserver 未运行 |
| 写入报 429 | APF / 客户端风暴 | `apiserver_request_total`、UA 统计 | 无缓存 LIST、组件刷量 |
| 全量写失败 `database space exceeded` | etcd 配额 | `etcdctl alarm list` | 未压缩、Event 洪泛 |
| 节点批量 NotReady | 心跳通道 | `describe node` heartbeat + kubelet 日志 | apiserver 限流、网络 |
| 组件功能停摆但进程在 | 未选上主 | `-n kube-system get leases` | leader 挂、apiserver 不可达 |
| Pod 长期 Pending 无事件 | 调度器/队列 | `scheduler_pending_pods`、scheduler 日志 | scheduler leader 异常、插件阻塞 |
| HPA `<unknown>` | metrics-server | `kubectl top pods`、`describe hpa` | metrics-server 挂、requests 过高 |
| 节点雪崩重启 | PLEG / 磁盘 | `journalctl -u kubelet`、`crictl ps -a` | 僵尸容器、镜像盘满 |

## 7.2 必查指标清单（建议做成看板）

```text
控制面：
  apiserver_request_duration_seconds (P99, by verb/resource)
  apiserver_current_inflight_requests
  apiserver_admission_webhook_admission_duration_seconds
  etcd_request_duration_seconds / etcd_disk_wal_fsync_duration_seconds
  etcd_server_has_leader, etcd_mvcc_db_total_size_in_use_in_bytes
控制器：
  workqueue_depth / workqueue_queue_duration_seconds
  scheduler_pending_pods, scheduler_e2e_scheduling_duration_seconds
节点：
  kubelet_runtime_operations_duration_seconds
  container_runtime_operations_error_total
集群：
  apiserver_storage_objects (by resource)
  kube_node_status_condition
```

## 7.3 控制面高可用与运维规范

1. **多副本 + 多 AZ**：apiserver 至少 3 副本负载均衡；etcd 3/5 节点跨可用区。
2. **控制面独占节点**：独立节点池 + 本地 SSD + `system-cluster-critical` PriorityClass + 污点隔离。
3. **证书生命周期自动化**：`kubeadm certs check-expiration` 纳入定期巡检，或用 cert-manager / 自动轮转方案，绝不等过期后救火。
4. **etcd 自动压缩 + 定时快照 + 异地存储 + 季度恢复演练**。
5. **扩展点治理**：所有 mutating/validating webhook 必须 `failurePolicy: Ignore`（或至少排除 `kube-system` 与自身命名空间）+ 超时上限。
6. **APF 优先级设计**：为 `system:nodes`、`kube-system`、Operator 分别规划优先级与并发份额。
7. **升级纪律**：小版本灰度（先单 apiserver、再全量），控制面版本与节点 kubelet 版本偏差遵守官方支持窗口。
8. **演练文化**： Chaos 测试要覆盖"apiserver 单副本挂""etcd 单 member 挂""webhook 后端挂""核心节点池失联"四类场景。

## 7.4 写在最后

控制面故障有一个共同特征：**表象在业务，根因在平台**。Pod 起不来、Service 不通、节点 NotReady，很多时候只是 apiserver 被刷爆、etcd 慢盘、webhook 自锁的下游回声。因此控制面排障的关键能力不是记命令，而是**掌握"卡在哪一层"的分层判断**：

```text
客户端能否连上？        → 证书 / LB / 网络
   ↓ 能
读能，写不能？          → 准入 webhook / etcd 只读
   ↓ 都能
慢？                  → etcd 磁盘 / 请求并发 / 大对象
   ↓ 不慢
功能不生效？            → 选主 lease / 控制器队列
   ↓ 正常
Pod 层问题？           → 回到系列一/二/三
```

至此，Kubernetes 排障实战系列完成了从**应用层（Pod/Service/Ingress）→ 网络层（CNI/DNS）→ 存储层（PV/CSI）→ 平台层（控制面/性能）**的完整闭环。四层知识合起来，就是一套可落地的生产排障方法论。

---

**系列导航**：

- 系列一：Pending / CrashLoopBackOff / Service / Ingress
- 系列二：网络 - CNI / DNS / 连通性
- 系列三：存储 - PV / PVC / CSI
- 系列四（本文）：控制面与性能排障
