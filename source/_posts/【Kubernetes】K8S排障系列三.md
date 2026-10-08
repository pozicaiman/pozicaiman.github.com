---
title: Kubernetes 排障实战系列（三）：存储 - PV / PVC / CSI
date: 2026-10-08 22:00:00
categories: [Kubernetes]
tags: [Kubernetes, 排障, PV, PVC, CSI, StatefulSet, VolumeSnapshot, 存储]
---

# 第 1 章：引言——存储链路的四个阶段

系列一和系列二解决的是"计算"和"网络"的问题，但真正让运维同学夜不能寐的，往往是**有状态服务**：数据库主从切换后数据卷挂不上、PVC 卡在 Pending 两小时、Pod 一直 `ContainerCreating` 且事件里只有一句 `MountVolume.SetUp failed`。

存储排障难，难点在于它的链路比 Pod 和网络都长：**一个卷从"用户提交 PVC"到"容器里能读写文件"，要经过四个完全不同的子系统**。把它们背下来，后面所有章节都是这张图的展开。

```text
用户视角                          控制面视角                        节点视角
────────────────────────────────────────────────────────────────────────────
kubectl apply PVC
      │
      ▼
【阶段一 Provision】   PVC Pending ──> StorageClass ──> CSI provisioner
      │                                                  （external-provisioner）
      │  产出：PV 对象（或绑定已有静态 PV）
      ▼
【阶段二 Attach】      PV Bound ──> AttachDetachController ──> VolumeAttachment
      │                                                  （external-attacher）
      │  产出：卷"接到"了目标节点的总线上
      ▼
【阶段三 Mount】       kubelet VolumeManager ──> CSI node plugin（DaemonSet）
      │                                            NodeStageVolume / NodePublishVolume
      │  产出：/var/lib/kubelet/pods/<uid>/volumes/... 可访问
      ▼
【阶段四 文件系统/应用】 fsck / 权限 / quota / 应用真正 open() 读写
                                                    └──> 应用报 permission denied
```

## 1.1 一句话记住四个阶段的分工

| 阶段 | 谁负责 | 失败典型症状 | 第一手证据 |
|------|--------|--------------|------------|
| Provision | CSI controller（external-provisioner） | PVC 一直 `Pending` | PVC 的 `events`、provisioner 日志 |
| Attach | AttachDetachController + external-attacher | Pod `ContainerCreating`，事件 `timed out waiting for the condition` | `VolumeAttachment` 对象、CSI controller 日志 |
| Mount | kubelet + CSI node plugin | 事件 `MountVolume.SetUp failed for volume` | 节点 `/var/lib/kubelet/plugins_registry`、node plugin 日志 |
| 文件系统/应用 | 应用本身 + 存储后端 | Pod Running 但应用报 IO/权限错误 | `kubectl exec` 进去实测、`dmesg` |

> **关键认知**：`ContainerCreating` 不等于"镜像没拉完"。在有状态 Pod 里，超过 80% 的 `ContainerCreating` 是**卷没挂上**。先看 `kubectl describe pod` 的 Events 里有没有 `MountVolume` / `FailedAttachVolume` / `FailedMount`，再决定往哪个阶段查。

## 1.2 排障黄金顺序

1. `kubectl get pvc -A`：先看 PVC 状态，`Pending` / `Bound` / `Lost`。
2. `kubectl get pv`：PV 是否存在、`Capacity` / `AccessModes` / `StorageClass` / `Claim` / `Status` / `ReclaimPolicy`。
3. `kubectl describe pvc <name> -n <ns>`：**看 Events**，Provision 阶段的失败原因几乎都写在这里。
4. `kubectl describe pod <name> -n <ns>`：**看 Events**，Attach / Mount 阶段的失败原因在这里。
5. `kubectl get volumeattachment`：确认 Attach 是否完成、是否卡在某个节点上。
6. `kubectl logs -n <csi-ns> <csi-controller-pod> -c csi-provisioner / csi-attacher`：看 CSI 侧真实报错。
7. 上节点：`lsblk`、`mount | grep <volume>`、`dmesg -T | tail`、`journalctl -u kubelet`。

## 1.3 本章常用命令速查

```bash
# 存储全家桶一次性看状态
kubectl get pvc,pv -A -o wide
kubectl get volumeattachment -o custom-columns=\
NAME:.metadata.name,ATTACHER:.spec.attacher,NODE:.spec.nodeName,SOURCE:.spec.source.persistentVolumeName,attached:.status.attached

# 找到某个 PVC 背后的 PV 与 CSI 属性
kubectl get pvc data-mydb-0 -n mysql -o jsonpath='{.spec.volumeName}{"\n"}'
kubectl get pv <pv-name> -o yaml | sed -n '/csi:/,/nodePublishSecretRef:/p'

# CSI 驱动与容量拓扑
kubectl get csidriver
kubectl get csistoragecapacities -A
kubectl get storagecapacity -A
```

---

# 第 2 章：PVC 一直 Pending

PVC Pending 是存储排障里最高频、也最容易定位的问题——**原因基本全部写在 `kubectl describe pvc` 的 Events 里**，怕的是看不懂它在说什么。

```text
                    PVC 提交后一直 Pending
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
 没有可用 PV         provisioner 没跑       参数/权限被拒
 (静态供给)         (动态供给故障)         (SC 配置错误)
        │                   │                   │
 "no persistent volumes      "provisioning      "storageclass
  available for claim"       failed"            storage-provisioner
        │                   │                   not found"
        ▼                   ▼                   ▼
 看 PV 的容量/访问模式    看 provisioner 日志   看 SC 是否存在、
 /节点拓扑是否匹配        与后端存储可达性      name 拼写是否正确
```

## 2.1 第一种：没有指定 StorageClass

**现象**：

```text
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  ProvisioningFailed ...  persistentvolume-controller
  storageclass "default" not found
```

或者直接显示 `WaitForFirstConsumer` 却没有事件——说明集群里根本没有 **default StorageClass**，而 PVC 又没写 `storageClassName`。

**排查**：

```bash
kubectl get sc
kubectl get sc -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}provisioner={.provisioner}{"\tdefault="}{.metadata.annotations."storageclass.kubernetes.io/is-default-class"}{"\n"}{end}'
```

**解决方案**：

```bash
# 把现有 SC 设为默认
kubectl patch sc <sc-name> -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

# 或者显式指定（推荐：生产环境别依赖默认值）
kubectl patch pvc data-mydb-0 -n mysql --type merge -p '{"spec":{"storageClassName":"ssd-csi"}}'
```

> **经典坑**：`spec.storageClassName` 在 PVC 绑定后**不可修改**。如果 PVC 已经 Bound 到错误的 SC，唯一干净的做法是：备份数据 → 删 PVC（先去掉 StatefulSet 或用 `whenDeleted` 策略）→ 用新 SC 重建。改字段这条路走不通。

## 2.2 第二种：`WaitForFirstConsumer` 延迟绑定——它不是故障

这是新版集群里**最常见的假告警**。Cloud 提供商的磁盘有可用区属性，提前造盘可能造在错误的 AZ，导致 Pod 调度不过去。因此现代 SC 默认（或推荐）：

```yaml
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

**现象**：PVC 显示 `Pending`，事件里一句：

```text
Waiting for first consumer to be created before binding
```

**这完全正常**。真正的判据是：**有没有对应的 Pod 在被创建**。

```bash
# PVC Pending，但先问：谁会用它的 Pod 起来了吗
kubectl get pod -n mysql -l app=mydb -o wide
kubectl get pvc -n mysql
```

如果 Pod 因为**资源不足 / 亲和性 / 污点**（见系列一第 2 章）调度不了，PVC 就会**永远 Pending**，此时故障根源在调度器，不在存储。

**验证是否真的进入了延迟绑定流程**：

```bash
kubectl get pv -w    # Pod 一旦被调度，几秒内应出现新 PV 并 Bound
kubectl describe pod <pod> -n mysql | grep -A10 Events
```

> **关键认知**：`WaitForFirstConsumer` 下 PVC Pending 是**正常状态**，Pod Pending 才是问题。看到这类告警先跳过去看 Pod，别看存储。

## 2.3 第三种：静态 PV 匹配不上

自建机房（NFS、Ceph、本地盘）经常用**静态供给**：管理员预先 `kubectl apply` 一批 PV，等 PVC 来自助领取。匹配规则极其严格，**四个条件全部满足才会 Bound**：

```text
PV.capacity        >= PVC.requests.storage
PV.accessModes     ⊇ PVC.accessModes            （PVC 要 RWX，PV 只有 RWO → 不匹配）
PV.storageClassName == PVC.storageClassName     （字符串完全相等，空串也算一个值）
PV 的 nodeAffinity  ⊇ Pod 可调度的节点拓扑      （若 PV 有亲和性）
```

**现象**：`no persistent volumes available for this claim and storage class`，且 `kubectl get pv` 里明明有几个 `Available`。

**排查**——把两边的关键字段并排看：

```bash
kubectl get pv -o custom-columns=\
NAME:.metadata.name,CAP:.spec.capacity.storage,AM:.spec.accessModes,SC:.spec.storageClassName,PHASE:.status.phase,NN:.spec.nodeAffinity.required.matchExpressions
echo '---'
kubectl get pvc -n mysql -o custom-columns=\
NAME:.metadata.name,REQ:.spec.resources.requests.storage,AM:.spec.accessModes,SC:.spec.storageClassName,PHASE:.status.phase
```

**解决方案**：

- 容量对不上：把 PV 做成 PV 容量略大于 PVC 请求（如 PV 10Gi / PVC 10Gi 可以，PV 5Gi / PVC 10Gi 不行）。
- 访问模式对不上：静态 PV 的 `accessModes` 要写全，NFS 类后端可以直接写 `[ReadWriteOnce, ReadOnlyMany, ReadWriteMany]`。
- `storageClassName` 对不上：**空字符串和非空是不匹配的**。要么两边都留空，要么两边都填同一个名字。
- 想手动指定绑定：在 PVC 里写 `volumeName`，或在 PV 里写 `claimRef`（提前"占位"，防止被别的 PVC 抢走）。

```yaml
# PV 预绑定给某个 PVC，避免多副本场景被抢
apiVersion: v1
kind: PersistentVolume
metadata:
  name: nfs-pv-01
spec:
  claimRef:
    namespace: mysql
    name: data-mydb-0
```

## 2.4 第四种：CSI provisioner 侧故障

PVC 事件里出现 `ProvisioningFailed`，说明已经走到了动态供给，但 CSI 控制器造盘失败。常见子原因：

| 事件消息关键词 | 根因方向 | 处置 |
|----------------|----------|------|
| `context deadline exceeded` | 后端存储 API 不可达 / 超时 | 查 CSI controller 到存储网关的网络、存储侧负载 |
| `Unauthorized` / `InvalidAccessKeyId` | Secret 凭据失效或轮转后没更新 | 更新 `csi-storage-secret`，重启 provisioner |
| `not found` / `invalid zone` | 可用区参数、`allowedTopologies` 与实际节点不符 | 修正 SC `parameters` 与节点标签 |
| `quota exceeded` / `no space left` | 云盘配额或存储池容量耗尽 | 扩配额 / 清理孤儿盘（见第 7 章） |
| `plugin is not registered` | CSI node/controller Pod 没起来或 socket 丢失 | 看第 3 章 CSI 组件排障 |
| `PersistentVolume is already bound` | 同名 PV 残留（回收不干净的脏数据） | 确认无引用后清理历史 PV |

**排查动作**（注意 provisioner 的容器名，多容器 Pod 必须 `-c`）：

```bash
kubectl -n kube-system get pods -l app=csi-provisioner -o wide
kubectl -n kube-system logs -l app=csi-provisioner -c csi-provisioner --tail=200 | grep -i "<pvc-name>"
kubectl -n kube-system logs <csi-controller> -c <driver-name> --tail=200   # 驱动主容器才有真实后端报错
```

## 2.5 综合案例：一批新 PVC 全部 Pending，日志里只有一句 `connection refused`

**现象**：某业务扩容 30 个副本，新 PVC 全 Pending，事件统一为：

```text
ProvisioningFailed: failed to provision volume with StorageClass "csi-rbd":
rpc error: code = Unavailable desc = connection error:
desc = "there is an instance of the legacy external-provisioner running"?
```

**排查过程**：

1. `kubectl get pods -n ceph-rook -o wide`：发现 `csi-provisioner` Pod **`CrashLoopBackOff`**。
2. `kubectl logs -c csi-provisioner`：报 `failed to connect to csi-rbd-controller: rpc error: code = Unavailable`。
3. 再看同命名空间下的 `csi-rbd-controller`（StatefulSet）：`0/1 ready`，describe 显示探针失败，节点上磁盘水位触发了驱逐。
4. `df -h` 到该节点：根分区 96%，容器日志目录被打满（Rook 的 CSI 日志级别开在 verbose）。

**解决方案**：清理节点磁盘（`journalctl --vacuum-size=500M`、轮转容器日志、给 `/var/lib/kubelet` 独立分区），把 CSI 日志级别调回默认，重建 controller Pod。PVC 在 provisioner 恢复后**自动完成供给**，无需重新提交。

**教训**：
- **CSI 组件自己也是需要"存活"的普通工作负载**——它有资源 requests、探针、日志、磁盘依赖。监控里必须给 CSI 的 DaemonSet/StatefulSet 单独设告警，它的故障半径是整个集群的存储。
- 排障时"下游报连接失败"往往要**再往下游看一跳**：connection refused 的真正原因在被拒绝的那个服务身上。

## 2.6 章末小结

- PVC Pending 的四条主线：**没有 SC / 延迟绑定（正常）/ 静态匹配失败 / provisioner 故障**。
- `WaitForFirstConsumer` 下先看 Pod，别看 PVC。
- 静态 PV 匹配是**四条件与**，容量、访问模式、SC 名、拓扑亲和缺一不可；空串与非空不相等。
- `ProvisioningFailed` 事件是 CSI 的报错，务必带 `-c` 看具体容器；注意凭据、配额、后端可达性三类原因。
- `storageClassName` 绑定后不可变，改类只能重建。

---

# 第 3 章：CSI 组件排障

CSI（Container Storage Interface）把存储驱动变成了**跑在集群里的普通 Pod**。这意味着 K8s 里所有排 Pod 的手段（系列一）在这里 100% 复用，但也意味着**存储链路多了一整套可失败的分布式组件**。

## 3.1 CSI 的组件构成

一个成熟 CSI 驱动（以 sidecar 模式部署）通常长这样：

```text
┌──────────────── CSI Controller（StatefulSet / Deployment，通常 2 副本选主） ────────────────┐
│                                                                                             │
│  csi-provisioner  ──watch PVC──>  CreateVolume / DeleteVolume          ─┐                   │
│  csi-attacher     ──watch VolumeAttachment──> ControllerPublish/Unpublish│                   │
│  csi-resizer      ──watch PVC 扩容──> ControllerExpandVolume             ├─> 同一个 unix     │
│  csi-snapshotter  ──watch VolumeSnapshot──> CreateSnapshot               │   socket:         │
│  csi-driver-registrar(仅 node) ──注册驱动──┐                            │  /csi/csi.sock    │
│  <driver-name>  ← 真正对接后端存储的实现 ←─┴────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────── CSI Node（DaemonSet，每节点一个） ────────────────┐
│  csi-node-driver-registrar ──> 向 kubelet 注册（/var/lib/kubelet/plugins_registry） │
│  <driver-name>             ──> NodeStageVolume / NodePublishVolume / ExpandVolume   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**sidecar 与驱动的通信**：同一个 Pod 内共享 emptyDir 上的 `csi.sock`。任何一个容器 crash，socket 消失，其他 sidecar 就会刷 `connection refused`——这就是第 2.5 案例的模式。

## 3.2 组件健康检查清单

```bash
# 1) 驱动是否注册成功
kubectl get csidriver
kubectl get pods -n <csi-ns> -o wide        # 每个节点都应有 node Pod，且 3/3 或 N/N Ready

# 2) 看注册产物是否落在节点上（上节点执行）
ls -l /var/lib/kubelet/plugins_registry/     # 应有 <driver>.registration 目录
ls -l /var/lib/kubelet/plugins/<driver.full.name>/csi.sock

# 3) kubelet 是否认识这个驱动
journalctl -u kubelet --since "-10m" | grep -i "<driver>" | grep -Ei "registered|volumelifecycle|capac"

# 4) sidecar leader 选举是否正常（多副本时）
kubectl get lease -n <csi-ns>
kubectl get lease -n <csi-ns> csi-attacher-leader-<driver> \
  -o jsonpath='{.spec.holderIdentity}{"  renew="}{.spec.renewTime}{"\n"}'
```

> **经典坑**：CSI node Pod 里 `csi-node-driver-registrar` 挂载的 `kubelet-dir` 路径**写死了 `/var/lib/kubelet`**。如果集群的 kubelet 用了自定义 root-dir（`--root-dir`）或是容器化 kubelet（Kubespray 等），registrar 会注册到空目录，症状是 `plugin is not registered` + 所有该驱动的卷挂载失败。改 `KUBELET_DIR` 或 hostPath 到真实路径即可。同理，**`privileged: true` 和 `hostPath` 被安全策略（PSP/OPA/PSA）拦截**时，node Pod 会一直 `CreateContainerConfigError`。

## 3.3 多副本 sidecar 卡住：leader 没选出来

现象：PVC 一直 Pending，但 provisioner Pod `Running 2/2`，日志循环打印：

```text
Attempting to acquire leader lease csi-provisioner-leader-<driver>...
```

排查与处置：

```bash
kubectl get lease -n <csi-ns> | grep provisioner
kubectl get lease -n <csi-ns> <name> -o yaml   # 看 holderIdentity 与 leaseDurationSeconds
# 常见原因：apiserver 限流（见系列四第 2 章）、RBAC 缺 permissions 给 coordination.k8s.io/leases
kubectl auth can-i create leases.coordination.k8s.io -n <csi-ns> --as=system:serviceaccount:<ns>:<sa>
```

## 3.4 用 CSI 官方外部存储测试套件验证驱动

当驱动是第三方交付、或刚升级完想快速确认基本能力：

```bash
git clone https://github.com/kubernetes-csi/external-provisioner
# csi-test 提供 csi-sanity，直接对着 socket 跑协议一致性
go run github.com/kubernetes-csi/csi-test/v5/cmd/csi-sanity \
  --csi.endpoint=unix:///var/lib/kubelet/plugins/<driver>/csi.sock \
  --csi.stagingpath=/var/lib/kubelet/plugins/kubernetes.io/csi/ \
  --csi.publishpath=/var/lib/kubelet/pods/.../volumes/
```

在节点上执行（需要 host 权限），它能精确告诉你驱动在 `NodeExpandVolume` 之类的可选能力上是否有 bug，比在集群里绕一圈快得多。

## 3.5 综合案例：升级集群后全部新卷挂载失败，旧卷没事

**现象**：集群从 1.24 升到 1.28，运行中的 Pod 一切正常，但**任何新建 Pod 挂卷都会 `MountVolume.SetUp failed`**：

```text
MountVolume.SetUp failed for volume "pvc-xxxx" :
rpc error: code = Internal desc = Could not mount ...
mount failed: cgroup v2 ... /sys/fs/cgroup
```

**排查过程**：

1. `MountVolume.SetUp failed` → 定位在**阶段三 Mount**，直接看节点上的 CSI node Pod。
2. `kubectl logs <csi-node> -c <driver> --tail=200`：报 `failed to parse cgroup`——驱动镜像是老版本，只认 cgroup v1。
3. 旧卷没事是因为它们**从未发生 attach/mount 动作**（kubelet 只是沿用已有挂载点），这正好解释了"存量正常、增量全挂"的模式。

**解决方案**：升级 CSI 驱动镜像到支持 cgroup v2 的版本；或者临时把节点切回 cgroup v1（`systemd.unified_cgroup_hierarchy=0` 重启）。

**教训**：
- **"存量正常、增量失败"是组件版本不兼容的强特征**。凡是这个模式，第一反应去看新操作的执行路径上的二进制版本，而不是数据本身。
- 节点 OS 大版本变化（cgroup v1 → v2、`/etc/fstab`、内核模块 `nf_conntrack`）都会打断存储驱动，**升级 CSI 和升级 OS/K8s 要当作同一个变更管理**。

## 3.6 章末小结

- CSI = 一堆跑在集群里的普通 Pod：`provisioner / attacher / resizer / snapshotter` + 驱动本体，controller 侧多副本走 Lease 选主，node 侧是 DaemonSet。
- 所有 sidecar 共用一个 `csi.sock`，驱动主容器 crash 会让全套 sidecar 报 `connection refused`——**看日志必须追到真正对接后端的那个容器**。
- 三大高频配置坑：kubelet root-dir 不是 `/var/lib/kubelet`、`privileged/hostPath` 被安全策略拦、Lease 相关 RBAC 缺失。
- "存量正常、增量失败" → 组件版本或节点 OS 变更。

---

# 第 4 章：卷挂载失败（FailedAttachVolume / FailedMount）

PVC 已经 Bound，Pod 却卡在 `ContainerCreating`——问题在 Attach 或 Mount 阶段。二者的区分靠事件里的 Reason。

```text
Pod ContainerCreating + 事件 Reason 分类
        │
        ├─ FailedAttachVolume ──> 【阶段二 Attach】
        │    "Multi-Attach error for volume"
        │    "volume is already attached by pod xxx"
        │    "timed out waiting for the condition"
        │
        └─ FailedMount ─────────> 【阶段三 Mount】
             "MountVolume.SetUp failed for volume"
             "nodeID ... not found"
             "no such file or directory" / "device is busy"
```

## 4.1 Multi-Attach error：AccessModes 的真相

这是**最高频**的挂载失败：

```text
Multi-Attach error for volume "pvc-xxx".
Volume is already exclusively attached to one node and can't be attached to another
```

根因：**`ReadWriteOnce` 不等于"一个卷可以被任意多个 Pod 使用"**。RWO 的准确语义是"**同一个卷只能被单个 Node 以读写方式挂载**"。当同一个 RWO 卷被两个 **Pod 分布在不同节点** 引用时，调度器把它放到第二个节点，attach 就必然冲突。

**三种典型触发场景**：

1. **两个独立 Deployment 共用一个 RWO PVC**（配置错误，应该用 RWX 或拆 PVC）。
2. **滚动更新期间的"新旧 Pod 交叠"**：Deployment/StatefulSet 更新，旧 Pod 还没完全终止，新 Pod 已被调度到其他节点。
3. **节点失联后 Pod 被重建**：旧节点状态未知但卷仍在其上 attached，新节点抢不到。

**排查**：

```bash
kubectl get volumeattachment | grep <pv-name>
kubectl get pv <pv-name> -o jsonpath='{.spec.accessModes}{"  claim="}{.spec.claimRef.namespace}/{.spec.claimRef.name}{"\n"}'
# 谁在使用这个卷
kubectl get pods -A -o json | jq -r '
  .items[] | select(.spec.volumes[]?.persistentVolumeClaim.claimName=="<pvc>") |
  "\(.metadata.namespace)/\(.metadata.name) node=\(.spec.nodeName)"'
```

**解决方案**：

| 场景 | 处置 |
|------|------|
| 多 Pod 共享（本就该共享） | 换用支持 RWX 的存储（NFS、CephFS、Lustre、云文件存储），`accessModes: ReadWriteMany` |
| 滚动更新交叠 | Deployment 用 `strategy.rollingUpdate.maxSurge: 0`；或改用 StatefulSet + `podManagementPolicy: OrderedReady` + 合适的 `volumeClaimTemplates` |
| 节点失联残留 | 等 `--attached-mount-reconciler-sync-interval` 自动收敛；急时人工确认旧节点已下线后 `kubectl delete volumeattachment <va>` 并强制驱逐旧 Pod（`kubectl delete pod --grace-period=0 --force`） |
| 需要"同一应用多副本共享" | 用 `ReadWriteOncePod`（RRWO，1.28+ GA），语义更严格：整卷只允许**一个 Pod**（而非一个节点）挂载，可避免同节点多 Pod 抢写 |

> **关键认知**：`ReadWriteOncePod` 是解决"共享卷被误用"的利器——它在**准入阶段**就拒绝第二个 Pod，而不是等到 attach 才在节点上报 Multi-Attach。前提是 CSI 驱动声明了 `VOLUME_ACCESSIBILITY_CONSTRAINTS` / `SINGLE_NODE_MULTI_WRITER` 能力，用 `kubectl get csidriver <driver> -o jsonpath='{.spec.volumeLifecycleModes} {.spec.attachRequired}'` 确认。

## 4.2 `timed out waiting for the condition`：Attach 超时

```text
FailedAttachVolume: AttachVolume.Attach failed for volume "pvc-xxx" :
rpc error: code = DeadlineExceeded desc = timed out waiting for the condition
```

含义：kubelet/controller 发起了 `ControllerPublishVolume`，但 CSI attacher 在超时窗口内没等到后端确认可见。**云盘场景尤其常见**，因为云 API 是异步的。

排查方向：

```bash
# 1) attacher 是否真的在处理
kubectl -n <csi-ns> logs deploy/csi-attacher -c csi-attacher | grep <pv-name>
# 2) VolumeAttachment 是否卡在 status.attached=false
kubectl get volumeattachment <name> -o jsonpath='{.status}{"\n"}'
# 3) 节点标识是否与后端一致（node name vs 云实例 ID）
kubectl get node <node> -o jsonpath='{.metadata.labels}{"\n"}' | tr ',' '\n' | grep -iE "instance-id|zone|region"
# 4) 云侧真实状态：盘是否 attached，挂的是哪个实例
```

**常见根因与解法**：

- **实例 ID 映射错**：节点名与云实例 ID 对不上（自定义 `providerID` 缺失）。给 Node 打 `spec.providerID`（由 cloud-controller-manager 负责），或在 CSI 配置里开启 `--node-name-override`。
- **盘和实例不在同一可用区**：云盘只能在同 AZ 挂载。用 SC 的 `allowedTopologies` 限定，或依赖 `WaitForFirstConsumer` 让调度器先选节点再造盘。
- **云 API 限流**：批量扩容时 attach 请求被限流。给 CSI 加 `--timeout`、`--worker-threads`，并在云侧申请提额。
- **旧挂载未 detach**：`VolumeAttachment` 残留，先解系列四里的心跳/节点失联问题，再清理。

## 4.3 `MountVolume.SetUp failed`：节点侧挂载

这一类必须**上节点**看，光靠 `kubectl` 拿不到足够信息。

```bash
# 定位到 Pod 所在节点后
ssh <node>
journalctl -u kubelet --since "-15m" | grep -i "<pod-uid 或 pv-name>"
mount | grep kubelet
lsblk -f
dmesg -T | tail -50                    # 内核层的报错（iscsi/nvme/多路径/文件系统）
findmnt -T /var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~csi/<pv>/mount
```

事件文案 → 根因对照：

| 事件 Message 关键词 | 根因 | 处置 |
|---------------------|------|------|
| `nodeID "..." not found` | kubelet 未注册到 CSI（`--kubelet-registration-path` 与 hostPath 不一致） | 修正 DaemonSet 的两个挂载路径 |
| `no such file or directory` | stage/publish 路径不存在，或被容器逃逸清理 | 重启 kubelet 重建目录，确认 `/var/lib/kubelet/plugins/kubernetes.io/csi/` |
| `device is busy` | 上一次挂载的 mount namespace 未释放 | `umount -l <path>`；检查是否有进程占用 |
| `mount failed: permission denied` | 文件系统 UID/GID 与 Pod `securityContext` 不匹配 | 见 4.4 |
| `wrong fs type` | 云盘格式化与 `fsType` 参数不一致 | 用 `mkfs` 校正，或让 provisioner 自动格式化 |
| `node volume config references unknown volume` | PV `nodeAffinity` 与实际节点标签不符 | 修拓扑或换 SC |
| `xfs: bad magic` / I/O error in `dmesg` | 后端磁盘或文件系统真损坏 | 停写、快照恢复、联系存储侧 |

## 4.4 权限问题：挂上了但应用写不了

**现象**：Pod `Running`，但日志报 `open /data/app.log: permission denied`。这是阶段四，卷本身是好的。

```bash
kubectl exec -it <pod> -- sh -c 'id; ls -ld /data; touch /data/.w && echo OK || echo FAIL'
kubectl exec -it <pod> -- stat -c '%u:%g %a %n' /data
kubectl get pod <pod> -o jsonpath='{.spec.securityContext}{"\n"}{.spec.containers[*].securityContext}{"\n"}'
```

解决方案（优先级从上到下）：

```yaml
# 1) 最干净：让 Pod 以卷主人的 UID 运行，并把组共享给容器内进程
spec:
  securityContext:
    fsGroup: 1000            # 挂载时 chgrp + setgid 到 volume 根，仅对可写卷生效
    runAsUser: 1000
    runAsGroup: 1000
# 2) 静态 NFS 场景：后端导出目录本身 chown/chmod（NFS 走的是服务端权限）
# 3) 兜底：initContainer 提前 chown（会拖慢启动，且对只读卷无效）
```

> **经典坑**：`fsGroup` 对**部分 CSI 驱动需要 `FSGroupPolicy`** 才生效：

```bash
kubectl get csidriver <driver> -o jsonpath='{.metadata.name}{"  fsGroupPolicy="}{.spec.fsGroupPolicy}{"\n"}'
```

三种策略含义——`File`（会真的 chown/chmod 文件系统）、`None`（不处理，权限完全靠应用或后端）、`ReadWriteOnceWithFSType`（只有 RWO 且有文件系统时才处理）。云厂商驱动常设为 `None`，此时**设了 `fsGroup` 却仍 permission denied** 就是预期行为，必须改后端导出权限或用 initContainer。

## 4.5 综合案例：StatefulSet 单副本重建后永远起不来

**现象**：MySQL StatefulSet 副本数 1，Pod 所在节点宕机被自动隔离，新 Pod 被调度到其他节点，卡在 `ContainerCreating`：

```text
AttachVolume.Attach failed for volume "pvc-data-mysql-0" :
rpc error: code = Internal desc = volume pvc-xxx is attached to node i-0abc...
```

**排查过程**：

1. `kubectl get volumeattachment -o wide`：确认 `attached=true` 但 `nodeName` 是被隔离的旧节点。
2. `kubectl get node <old> `：`NotReady,SchedulingDisabled`——**它并没有真下线**，云侧实例仍在运行（只是 kubelet 挂了），因此云盘仍挂在那台实例上。
3. 只要旧实例还持有盘，新节点就抢不到——这是云盘"一个盘同一时刻只能挂一台实例"的硬约束。

**解决方案**：

```bash
# 优先走 K8s 语义：让控制器认为旧 Pod 已终止（触发 detach）
kubectl delete pod mysql-0 --grace-period=0 --force
kubectl get volumeattachment -w        # 等待旧 VA 消失
# 若 attach 残留未清（cloud provider 侧状态不同步），最后在云控制台强制 detach
```

**教训**：
- **`--force --grace-period=0` 删除 Pod 只是告诉 API "我认为它没了"**，它不会替你解除云侧的挂载；对 RWO 卷的故障转移，**必须确认旧实例真的停止或盘真的 detach**，否则新 Pod 永远起不来。
- 单副本有状态服务在 K8s 里**天生就有"恢复即冲突"的问题**：要么多副本 + 存储层支持（Ceph/Rook 的 RWO 迁移、云盘强制 detach），要么应用层自己做数据冗余（主从 + binlog），不要指望块存储帮你完成故障转移。

## 4.6 章末小结

- 用事件 Reason 分流：`FailedAttachVolume` → 控制面/云 API；`FailedMount` → 节点与内核层；无事件但 `Running` 报错 → 权限/文件系统。
- RWO 是"**一个节点**读写"，不是"一个 Pod"；跨节点必冲突。同节点多 Pod 抢写用 `ReadWriteOncePod`。
- Attach 超时四大根因：providerID 不匹配、跨可用区、云 API 限流、旧挂载未释放。
- `MountVolume.SetUp failed` 必须上节点，`journalctl -u kubelet` + `dmesg` 是真相所在地。
- `fsGroup` 是否生效由 CSIDriver 的 `fsGroupPolicy` 决定，先查再配。

---

# 第 5 章：StatefulSet 与 volumeClaimTemplates

有状态工作负载的存储排障，核心是理解 `volumeClaimTemplates` 的**不可变**特性与它的生命周期语义。

## 5.1 命名与绑定规律

```text
StatefulSet: mydb (replicas=3, volumeClaimTemplates: data)
      │
      ├── Pod mydb-0  ── PVC ──> data-mydb-0   ── PV pvc-aaa
      ├── Pod mydb-1  ── PVC ──> data-mydb-1   ── PV pvc-bbb
      └── Pod mydb-2  ── PVC ──> data-mydb-2   ── PV pvc-ccc
```

PVC 名 = `<templateName>-<statefulSetName>-<ordinal>`，一旦创建就**独立于 StatefulSet 存在**：

- `kubectl delete sts mydb` → Pod 消失，但 **PVC/PV 默认保留**（防误删数据）。
- `kubectl delete pvc data-mydb-0` → StatefulSet **不会**自动重建这个 PVC，需要手动或靠 1.30+ 的 `pvcRetentionPolicy`。

```bash
# 检查三件套是否齐（缺一个就说明数据卷被删了）
kubectl get sts -n mysql mydb -o jsonpath='{.spec.volumeClaimTemplates[*].metadata.name}{"\n"}'
kubectl get pvc -n mysql -l app=mydb
kubectl get pv | grep -E "pvc-(aaa|bbb|ccc)"
```

## 5.2 volumeClaimTemplates 不可变：最常见的 `Forbidden` 报错

**现象**：改了 StatefulSet 的 `volumeClaimTemplates`（如 `storageClassName` 或 `resources.requests.storage`），apply 时被拒：

```text
The StatefulSet "mydb" is invalid: spec: Forbidden:
updates to statefulset spec for fields other than
'replicas', 'rbacBinding', 'template', 'updateStrategy' or 'persistentVolumeClaimRetentionPolicy' are forbidden
```

**这是设计如此**：PVC spec 里绝大多数字段不可变，StatefulSet 也就禁止改模板。**唯一干净的做法是重建**：

```bash
# 1) 停掉控制器但保留 Pod 与 PVC（1.27+ 的 pvcRetentionPolicy 让这一步更安全）
kubectl patch sts mydb -n mysql -p '{"spec":{"persistentVolumeClaimRetentionPolicy":{"whenScaled":"Retain","whenDeleted":"Retain"}}}'
# 2) 导出 sts，删掉 volumeClaimTemplates 里 metadata.name 冲突项，改容量/SC
kubectl get sts mydb -n mysql -o yaml > sts.yaml      # 手工编辑 + 清理 status/resourceVersion
# 3) 先备份数据（快照，见第 6 章），再删 sts + 对应 PVC，然后 apply 新的
kubectl delete sts mydb -n mysql
kubectl delete pvc data-mydb-0 data-mydb-1 data-mydb-2 -n mysql
kubectl apply -f sts.yaml
```

> **教训**：**永远不要在生产"顺手改一下 SC 名"来试新存储类**。StatefulSet 模板变更等价于"删库重建"，唯一保护措施是事前 VolumeSnapshot。

## 5.3 卷扩容：allowVolumeExpansion

K8s 扩容卷**只能变大不能变小**，且需要三处同时具备条件：

```text
SC.allowVolumeExpansion: true   ┐
CSI 驱动声明 EXPAND_REQUIRED /   ├─> PVC 改 requests → 外部 resizer → ControllerExpand → NodeExpand
   Offline 扩容能力             ┘    (在线扩容对"正在使用的卷"需要驱动支持)
```

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ssd-csi
provisioner: csi-driver.example.com
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

```bash
# 1) 前置检查
kubectl get sc ssd-csi -o jsonpath='{.allowVolumeExpansion}{"\n"}'
kubectl get csidriver csi-driver.example.com -o yaml | grep -A5 volumeExpansion    # 或看 --extra-create-metadata
# 2) 发起扩容（改 PVC，不是改 PV）
kubectl patch pvc data-mydb-0 -n mysql -p '{"spec":{"resources":{"requests":{"storage":"40Gi"}}}}'
# 3) 观察状态转换: FileSystemResizing -> 完成
kubectl get pvc data-mydb-0 -n mysql -o jsonpath='{.status.conditions}{"\n"}'
kubectl get pv -w | grep <pv>
```

失败状态解读：

| PVC 状态 / 事件 | 含义 | 处置 |
|-----------------|------|------|
| `FileSystemResizePending` 长期不变 | 需要 Pod 重启才能完成 NodeExpand（离线扩容型驱动） | 滚动重启使用该卷的 Pod |
| `Resizing` 后回退且事件 `Expansion not allowed` | SC 没开 `allowVolumeExpansion` | 开 SC；注意 SC 的这个字段可改，但**已存在的 PV 不会自动继承**，需 patch PV |
| `requested volume size ... must be greater` | 缩容被拒（合法行为） | 只能重建 |
| PVC 显示 40Gi，Pod 内 `df` 仍 20Gi | 控制面扩了、文件系统没扩 | 看 node plugin 日志；手动 `xfs_growfs /data` 或 `resize2fs` 作为应急 |

## 5.4 孤儿 PVC 与数据残留

`ReclaimPolicy: Retain` + 手动删 PVC，是最容易留下"数据资产"的组合：

```bash
# PV Released 却没有对应 PVC：卷被保留了，等你决定
kubectl get pv | awk '$5=="Released"{print $1}'
kubectl get pv <pv> -o jsonpath='{.spec.claimRef.namespace}/{.spec.claimRef.name}{"\n"}'
# 决定复用：清空 claimRef 让它回到 Available（谨慎！里面有旧数据）
kubectl patch pv <pv> -p '{"spec":{"claimRef":null}}'
# 决定销毁：备份后删除 PV，再让存储侧清理物理卷
```

> **经典坑**：`kubectl delete pvc` **不会**级联删除 `ReclaimPolicy: Retain` 的 PV，但会**级联删除 `Delete` 策略下的后端物理盘**。一旦 PVC 被误删且策略是 Delete，恢复窗口取决于云侧是否支持回收站/快照——这也是第 6 章快照必须存在的原因。生产集群建议：核心业务 SC 用 `Retain`，并通过 PVC finalizer `kubernetes.io/pvc-protection` 防止在用卷被删。

## 5.5 综合案例：扩容后 `df` 没变，业务仍报 no space left

**现象**：PVC 从 20Gi 扩到 40Gi，`kubectl get pvc` 显示 40Gi，Pod 里 `df -h /data` 仍 20Gi，MySQL 持续 `No space left on device`。

**排查过程**：

1. `kubectl get pvc data-mysql-0 -o jsonpath='{.status.capacity}'` = 40Gi，说明 **ControllerExpand 已成功**。
2. `kubectl get pvc ... -o jsonpath='{.status.conditions}'` = `FileSystemResizing=True`，说明卡在 **NodeExpand**。
3. `kubectl logs <csi-node> -c <driver> | grep -i expand`：报 `target is busy`——`/data` 上有打开的文件句柄且该驱动要求独占做 `resize2fs`。
4. `lsof +f -- /var/lib/kubelet/pods/.../mount | head` 定位到备份 agent 在扫描。

**解决方案**：停掉备份任务 → `kubectl delete pod mysql-0`（StatefulSet 重建，NodeExpand 在挂载时完成）→ `df -h` 显示 40Gi，问题解决。

**教训**：
- **容量扩容是"三层"的：API 层（PVC/PV 数字）→ 块设备层（ControllerExpand）→ 文件系统层（NodeExpand）**。`df` 看到的是第三层，任何"扩了没生效"都要先判断卡在哪一层。
- 在线扩容依赖驱动能力声明，**不声明的驱动就是必须重启 Pod**——这是能力，不是 bug，写进运维手册比每次都现场猜要省时间。

## 5.6 章末小结

- `volumeClaimTemplates` 生成的 PVC 独立于 StatefulSet；删 sts 不删 PVC，**删 PVC 不会自动补建**。
- 模板不可变，改容量/SC 必须走"快照 → 删 → 建"，务必先备份。
- 扩容三条件：SC `allowVolumeExpansion`、驱动支持、只能变大；`FileSystemResizing` 卡住多为离线扩容或设备占用。
- `Retain` 卷的 `Released` 状态是资产也是风险，明确复用与销毁流程。

---

# 第 6 章：快照、备份与恢复（VolumeSnapshot）

块存储的快照是**有状态服务的最后一道保险**。K8s 通过 CRD 把它标准化：`VolumeSnapshotClass → VolumeSnapshot → VolumeSnapshotContent`，结构与 PVC/PV 完全对称。

## 6.1 组件与前置条件

```text
VolumeSnapshot (ns 级，用户提交)
      │  watch
      ▼
external-snapshotter sidecar ──> csi-snapshotter ──> CreateSnapshot RPC
      │                                                    │
      ▼                                                    ▼
VolumeSnapshotContent (集群级)                     后端存储生成快照
```

```bash
# 1) CRD 是否装好
kubectl get crd | grep snapshot
# 2) sidecar 是否部署
kubectl -n <csi-ns> get deploy csi-snapshotter
kubectl -n <csi-ns> logs deploy/csi-snapshotter -c csi-snapshotter --tail=50
# 3) 驱动能力
kubectl get csidriver <driver> -o yaml | grep -i snapshot
```

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-snap-ssd
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: csi-driver.example.com
deletionPolicy: Delete        # Delete=删快照时连后端一起删；Retain=只删 K8s 对象
parameters:
  force-new-snapshot: "true"  # 由驱动定义，云厂商常见"强制新建而非复用"
```

## 6.2 制作快照与状态解读

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: mysql-0-snap-20261008
  namespace: mysql
spec:
  volumeSnapshotClassName: csi-snap-ssd
  source:
    persistentVolumeClaimName: data-mysql-0
```

```bash
kubectl get volumesnapshot -n mysql
# readyToUse=true 才是真的可用；false 时看 status.error
kubectl get volumesnapshot mysql-0-snap-20261008 -n mysql -o yaml | sed -n '/status:/,$p'
```

| 现象 | 含义 | 处置 |
|------|------|------|
| 长期 `readyToUse: false` 无 error | 后端异步创建中（大卷可能几十分钟） | 等待；`kubectl get volumesnapshotcontent` 看是否已生成 |
| `Invalid: the PVC is not bound` | PVC 未 Bound | 回到第 2 章 |
| `snapshotter not found` / 事件无 `Creating snapshot` | sidecar 没跑或 SC 名错 | 看 6.1 |
| `driver does not support` | 驱动未声明快照能力 | 该存储类不能做 CSI 快照，改用后端原生工具 |
| 快照成功但恢复报容量不足 | 快照容量按"已用量"而非 PVC 请求量 | 用 `--copy-volume-snapshot` 前先确认云侧配额 |

> **关键认知**：**快照 ≠ 备份**。快照是同一存储池/同一可用区的增量块，防的是"误删误改"；跨区域灾害要靠真正的备份（对象存储导出、数据库逻辑备份 + binlog）。把快照当备份是数据事故里最常见的一句话。

## 6.3 从快照恢复（克隆新 PVC）

恢复的本质是**新建一个 PVC，指定 `dataSource` 为快照**，而不是"把快照塞回原 PVC"：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-mysql-0-restored
  namespace: mysql
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: ssd-csi          # 必须与快照兼容，跨类可能不支持
  dataSource:
    name: mysql-0-snap-20261008
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  resources:
    requests:
      storage: 40Gi                   # 必须 >= 快照原始容量
```

```bash
# 先建 PVC 再起 Pod，确认 Bound 后才切换
kubectl get pvc data-mysql-0-restored -n mysql -w
# 让 StatefulSet 指向恢复卷：用 volumeClaimTemplates 的 name 覆盖技巧或临时用 Deployment 验证
kubectl run restore-check --rm -it --image=busybox --overrides='
{"spec":{"containers":[{"name":"c","image":"busybox","command":["sh","-c","ls -l /data; df -h /data"],"volumeMounts":[{"name":"v","mountPath":"/data"}]}],
 "volumes":[{"name":"v","persistentVolumeClaim":{"claimName":"data-mysql-0-restored"}}]}}'
```

正式恢复 StatefulSet 的推荐顺序：

```text
1. 停写（业务降级或 read_only）
2. 打一份新快照（保证"事故现场"可回溯）
3. kubectl scale sts mydb --replicas=0        # 或 delete pod，保留原 PVC 不删
4. 建 restored PVC（dataSource=快照）
5. 改 StatefulSet 模板 / 或用一张新 sts 指向 restored PVC 做影子验证
6. 验证数据 → 流量切回 → 保留原卷 7 天再清理
```

## 6.4 VolumeSnapshotContent 与跨命名空间迁移

`VolumeSnapshot` 是命名空间级、`VolumeSnapshotContent` 是集群级（对称于 PVC/PV）。**跨命名空间/跨集群恢复**要手工"解绑"：

```yaml
# 1) 先在目标集群手工建 VolumeSnapshotContent，把 existingSnapshotID 指向后端快照 ID
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotContent
metadata:
  name: vs-content-import
spec:
  deletionPolicy: Retain
  driver: csi-driver.example.com
  volumeSnapshotRef:
    name: snap-import
    namespace: app-ns
  source:
    snapshotHandle: csi-<backend-snapshot-id>
  volumeMode: Filesystem
  capacityBytes: 42949672960
```

```bash
kubectl apply -f vs-content-import.yaml
# 2) 建同名 VolumeSnapshot 引用它（source 用 volumeSnapshotContentName，不是 PVC）
kubectl apply -f - <<'EOF'
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata: {name: snap-import, namespace: app-ns}
spec:
  volumeSnapshotClassName: csi-snap-ssd
  source: {volumeSnapshotContentName: vs-content-import}
EOF
```

## 6.5 综合案例：误删 PVC，靠 Retain + 快照 20 分钟恢复

**现象**：`kubectl delete pvc data-mysql-0 -n mysql`（本想删 PVC 重建，但忘了该 SC 是 `Delete`）→ PV 进入删除流程，云盘已卸载并进入删除队列，Pod 永久 `ContainerCreating`。

**排查过程**：

1. `kubectl get pv`：原 PV 已消失，云侧 `DescribeVolumes` 查不到 → 物理盘已删。
2. 立刻查快照：`kubectl get volumesnapshot -A | grep mysql-0`，存在每日 02:00 的全量快照 `mysql-0-snap-20261008-0200`，`readyToUse=true`。
3. 数据丢失窗口 = 02:00 至事故时刻，需补 binlog。

**解决方案**：按 6.3 从快照克隆新 PVC（40Gi）→ 重新 Bound → 删除旧 StatefulSet 并让其指向新 PVC（`volumeClaimTemplates` 名保持一致、PVC 名沿用）→ 挂载后应用启动 → `mysqlbinlog` 回放 02:00 之后的增量到业务暂停点 → 校验主从一致 → 放量。全程 20 分钟。

**教训**：
- **`Delete` 回收策略 + 无快照 = 单点误删即数据永久丢失**。生产 PVC 删除必须走审批，或用 `kubernetes.io/pvc-protection` finalizer + 权限收敛（RBAC 禁 `delete pvc`）。
- **快照的 RPO 就是你的最大丢失量**。定时快照必须配合应用层的日志备份（binlog/WAL/Redo），否则小时级数据不可挽回。
- 事后立刻给命名空间打上 ResourceQuota / 限制 `Delete` 类 SC 的使用范围，把这类误操作变成"不可能"。

## 6.6 章末小结

- 快照三段式：`VolumeSnapshotClass / VolumeSnapshot / VolumeSnapshotContent`，sidecar 是 `csi-snapshotter`，驱动必须声明能力。
- `readyToUse=true` 才可用；`deletionPolicy` 决定删 K8s 对象时是否连后端一起删。
- 恢复 = 新建 PVC 并指定 `dataSource`；**先验证再起业务**，原卷保留 7 天。
- 快照不等于备份：跨区容灾需要真正的异地副本 + 应用层日志。

---

# 第 7 章：回收、清理与存储性能

## 7.1 回收策略与孤儿卷清理

```text
ReclaimPolicy 决策
   Delete  ──> PVC 删 → PV 删 → external-provisioner 调 DeleteVolume → 后端物理卷删除
   Retain  ──> PVC 删 → PV 进入 Released（数据保留）→ 人工复用或销毁
   (1.27+ 按策略) StatefulSet 的 persistentVolumeClaimRetentionPolicy:
                 whenDeleted: Delete|Retain   whenScaled: Delete|Retain
```

**孤儿卷**（后端有盘、K8s 无对象）是最贵也最隐蔽的浪费——计费持续、无人知晓：

```bash
# 1) 列出集群里所有仍在用的卷
kubectl get pv -o jsonpath='{range .items[*]}{.spec.csi.volumeHandle}{"\n"}{end}' | sort > in-cluster.txt
# 2) 从云/存储侧导出全部卷（以云盘为例，实际用各自 CLI）
#    aws ec2 describe-volumes --query 'Volumes[*].VolumeId' ...
#    or rook: ceph rbd image list ...
sort backend.txt > backend.sorted
comm -13 in-cluster.txt backend.sorted > orphans.txt     # 后端有、集群无
# 3) 删除前二次确认：无 VolumeAttachment、无快照引用、无 tag 标记为"保留"
```

> **教训**：孤儿卷清理**绝不能只看 K8s 对象**——快照、镜像卷、跨集群共享的卷都会让"看起来没人用"的盘实际是数据资产。标准做法：先给孤儿卷打 `keep-for-review=<date>` tag，静置 30 天无异议再物理删除；同时给 SC 打上团队归属，让 `Delete` 策略可被追责。

## 7.2 PV 卡 Terminating：finalizer

```bash
kubectl get pv pvc-xxx -o jsonpath='{.metadata.finalizers}{"\n"}'
# 典型：kubernetes.io/pv-protection（由 PV controller 管理，卷真的 detach/delete 完才会摘）
#      external-storage.kubernetes.io/<driver>（驱动自己加的）
```

- 卡 `pv-protection`：先看是否仍有 Pod 引用（`kubectl get pods -A -o json | jq ...`），再看 `VolumeAttachment` 是否还挂在失联节点上（回 4.5 处置）。
- 卡驱动 finalizer：查 CSI controller 的 `DeleteVolume` 日志，常见是后端 API 报错反复重试。修好后端可达性即可自动收敛。
- **强摘 finalizer 是危险操作**，它会让 K8s 忘记这个卷而后端盘仍在计费：

```bash
# 仅在你已确认后端已物理清理、或愿意手工清理时使用
kubectl patch pv pvc-xxx -p '{"metadata":{"finalizers":null}}'
```

## 7.3 存储性能问题定位

性能与故障不同，需要基线和分层指标。

```text
应用延迟 = 应用内部 + 文件系统 + 块层 + 网络/协议 + 后端盘
              │           │         │        │          │
            pprof      blktrace    iostat   tcpdump   存储侧监控
```

```bash
# 节点层：先判断是"慢"还是"堵"
iostat -xmt 1 20            # %util、await、r/s w/s、aqu_sz
# 关键：await 高但 %util 不满 => 后端或协议链路慢；%util≈100% => 盘本身被打满
iotop -Po                   # 谁在打 IO
mount | grep <vol>          # 是否 noatime、是否 sync、文件系统类型
cat /sys/block/<dev>/queue/nr_requests /sys/block/<dev>/queue/read_ahead_kb
```

常见性能陷阱清单：

| 现象 | 根因 | 优化 |
|------|------|------|
| 数据库随机 IO 延迟毛刺 | 云盘 burst 额度耗尽 / 快照创建期间降速 | 换预配置 IOPS 型盘；快照错峰；`force-new-snapshot=false` |
| 小文件吞吐极低 | 未开 `noatime`，元数据写放大 | `mountOptions: [noatime, nodiratime]` 写进 SC |
| 大文件读写被截断 | 单卷 IOPS/吞吐上限 | 分片到多 PVC，或换高规格存储类 |
| 扩容后反而变慢 | 文件系统碎片 / 未做在线 fsck | 排维护窗口 `xfs_repair`/`e2fsck -f` |
| 跨可用区延迟高 | 卷与 Pod 不在同 AZ | `allowedTopologies` + `WaitFirstConsumer`（呼应系列二第 6 章） |
| 网络文件系统 hang | NFS 服务端抖动 + 硬挂载 | `soft,timeo`（有数据风险）或换 `intr`/多路径；服务端限流 |
| 容器启动慢 | 卷初始化时 `fsGroup` 递归 chown 整个大目录 | 用 `fsGroupPolicy: None` + 预置权限；或数据目录与日志目录分离 |

NFS 特有的 hang（`unkillable` 进程、`D` 状态）：

```bash
ps -eo pid,stat,cmd | awk '$2 ~ /D/ {print}'
cat /proc/<pid>/stack          # 栈里出现 nfs_* / rpc_wait_bit
dmesg -T | grep -i "nfs: server .* not responding, tried reconnect"
```

处置：优先恢复服务端；`umount -l` 后再重挂；长期方案是 NFS 高可用（多网关 + DNS 漂移）或迁移到 CephFS/Lustre。

## 7.4 三类后端的典型差异速查

```text
         NFS / 共享文件存储        Ceph-Rook（块 + 文件）        云盘 EBS/PD/Zen 类
挂载方式    协议挂载（RWX 天然）      RBD 块 + CephFS 文件         块设备 attach 到实例
跨节点共享  可以（RWX）              RBD 不行 / CephFS 可以        不行（同 AZ 单挂载）
快照       多为目录级/后端工具        ceph rbd snap，原生快        云 API，异步、可能限速
故障半径   服务端挂 = 全集群该卷 hang monitor/OSD 抖动 = 全集群    单 AZ / API 限流
主要排障点 mount 权限、hang 进程     OSD/PG 状态、mon quorum       providerID、AZ、API 配额
```

```bash
# Rook/Ceph 专项三件套
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph status
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph df
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- rbd status <pool>/<image>
kubectl -n rook-ceph get cephcluster,cephblockpool
```

> **关键认知**：选后端就是在选**故障模式**。RWO 块存储的故障集中在 attach/跨区/配额；共享文件存储的故障集中在服务端 hang 与权限；Ceph 类分布式存储的故障集中在 quorum 与 PG 恢复期。排障前，先明确自己在哪一类里。

## 7.5 综合案例：整点备份任务引发全集群挂载抖动

**现象**：每天 02:00–02:30，多个命名空间的 Pod 报 `MountVolume.SetUp failed`、`connection reset by peer`，且部分 PVC 扩容卡住；02:30 自愈。

**排查过程**：

1. 时间高度规律 → 优先怀疑定时任务（呼应系列四"凌晨整点批量重启"的思路）。
2. `kubectl get cronjobs -A | grep -E "0 2|2 \*"`：发现集群级 Velero / 存储快照任务在 02:00 全量并发。
3. `kubectl get volumesnapshot -A --sort-by=.metadata.creationTimestamp | head -40`：02:00 一分钟内创建了 200+ 快照。
4. 存储侧监控：快照任务挤占后端带宽与元数据服务，`csi-snapshotter` 报 `deadline exceeded`；同一 provisioner 的 `CreateVolume`/`ExpandVolume` 队列被拖慢（`workqueue_depth` 升高，见系列四第 4 章）。

**解决方案**：
- 快照限流：`csi-snapshotter` 加 `--worker-threads=1`，并在快照任务里按命名空间**分批错峰**（02:00 核心库、03:00 其他）。
- 后端侧给快照设 QoS / 带宽上限；启用增量快照而非全量。
- 给 PVC 扩容、快照、备份三类操作加"变更窗口"约束，避开业务高峰与彼此。

**教训**：
- **CSI 各 sidecar 常常共享同一个后端连接与同一个驱动 Pod**，重 IO 的运维任务（快照/备份/迁移）会**污染**在线的供给与挂载请求。存储控制面也是控制面，同样需要限流与错峰。
- "有规律的抖动"是定时任务指纹。遇到就查 CronJob/Operator 的调度表，比按随机故障排查快一个数量级。

## 7.6 章末小结

- `Delete` 与 `Retain` 决定误删是"事故"还是"演练"；`persistentVolumeClaimRetentionPolicy` 让 StatefulSet 行为可声明。
- 孤儿卷要**双向对账**（集群 vs 后端），先打标静置再删，别一把梭。
- PV 卡 Terminating 看 finalizer 归属，强摘前必须确认后端已清理。
- 性能问题分层归因：`iostat` 区分"盘满"与"链路慢"，SC 的 `mountOptions` 是最便宜的优化。
- 快照/备份任务要限流错峰——存储控制面同样会被自己人打挂。

---

# 第 8 章：总结——存储排障速查表

拿到告警，先按这个表分流，再用对应章节的小结收口。

| 症状 / 关键事件 | 阶段 | 首选命令 | 最可能根因 | 详见 |
|-----------------|------|----------|------------|------|
| PVC `Pending` + `Waiting for first consumer` | — | `kubectl get pod -o wide` | Pod 没调度（非存储问题） | 2.2 |
| PVC `Pending` + `no persistent volumes available` | Provision | 并排对比 PV/PVC 字段 | 容量/访问模式/SC 名/拓扑不匹配 | 2.3 |
| PVC `Pending` + `ProvisioningFailed` | Provision | 带 `-c` 看 provisioner | 凭据、配额、后端不可达 | 2.4 |
| PVC `Pending` + 事件空白且无 default SC | Provision | `kubectl get sc` | 没有 default StorageClass | 2.1 |
| `Multi-Attach error` | Attach | `kubectl get volumeattachment` | RWO 跨节点被两 Pod 引用 | 4.1 |
| `timed out waiting for the condition` | Attach | 看 attacher + `providerID` | providerID 不符 / 跨 AZ / API 限流 | 4.2 |
| `MountVolume.SetUp failed` | Mount | `journalctl -u kubelet`、`dmesg` | nodeID、路径、设备占用、fs 类型 | 4.3 |
| Pod `Running` 但 `permission denied` | 文件系统 | `exec` 进容器 `stat` | UID/GID、`fsGroupPolicy` | 4.4 |
| CSI Pod `CrashLoopBackOff`、sidecar 刷 connection refused | 组件 | `logs -c <driver>` | 驱动主容器故障 / socket 丢失 | 3.2 |
| `plugin is not registered` | 组件 | `ls /var/lib/kubelet/plugins_registry` | kubelet root-dir 或注册路径不匹配 | 3.2 |
| `df` 容量未变但 PVC 已扩 | 扩容 | 看 `.status.conditions` | 离线扩容需重启 Pod 做 NodeExpand | 5.3 / 5.5 |
| `StatefulSet ... Forbidden` | 变更 | `kubectl get sts -o yaml` | 模板不可变，只能重建 | 5.2 |
| 快照长期 `readyToUse: false` | 快照 | `get volumesnapshotcontent` | 后端异步 / 驱动不支持 | 6.2 |
| PV 长期 `Terminating` | 回收 | 看 `metadata.finalizers` | 仍有引用 / 后端删除失败 | 7.2 |
| 后端有盘集群无对象（费用异常） | 回收 | `comm -13` 双向对账 | `Retain` 残留或 `Delete` 半途失败 | 7.1 |
| IO await 高、%util 不满 | 性能 | `iostat -xmt`、`iotop` | 后端/协议链路慢或快照抢占 | 7.3 / 7.5 |
| NFS 相关进程 `D` 状态不可杀 | 性能 | `/proc/<pid>/stack` | 服务端 hang | 7.3 |
| 整点/凌晨规律性挂载抖动 | 性能 | `get cronjobs -A` + 快照列表 | 备份/快照任务未限流 | 7.5 |

**四条通用原则（本系列反复出现的那四条）**

```text
1. 二分定位：先按阶段切开（Provision / Attach / Mount / 文件系统），再按对象切开（集群侧 vs 后端侧）。
2. 事件优先：PVC 的 Events 给 Provision 的答案，Pod 的 Events 给 Attach/Mount 的答案；
   两个 Events 都答不了，就必须上节点（journalctl + dmesg）。
3. 看版本与"存量/增量"：存量正常、增量失败 = 组件或 OS 变更；整点规律 = 定时任务。
4. 备份先行：任何涉及 PVC/PV/StatefulSet 模板的破坏性操作，第一步是 VolumeSnapshot，
   而且必须验证过它能恢复——没演练过的备份等于没有备份。
```

**存储侧预防清单（可直接抄进运维手册）**

- 每个 SC 标注归属团队、回收策略、扩容能力、`fsGroupPolicy`，禁止业务自建 SC。
- 核心业务 SC 统一 `reclaimPolicy: Retain` + 定期孤儿卷对账；命名空间级 RBAC 禁止普通成员 `delete pvc`。
- `WaitForFirstConsumer` 作为云盘类默认；跨可用区拓扑在 SC 层强制。
- 快照策略：核心库日全量 + 应用层日志备份（明确 RPO）；每季度做一次真实恢复演练并计时。
- CSI 组件纳入监控：Pod 就绪、Lease 续约、`workqueue_depth`、sidecar 报错关键词，与业务同权重。
- 快照/备份/迁移任务限流错峰，避免污染在线的供给与挂载请求。

**系列导航**

- 系列一：Pending / CrashLoopBackOff / Service / Ingress
- 系列二：网络（CNI / DNS / 连通性）排障
- 系列三（本文）：存储（PV / PVC / CSI）排障
- 系列四：控制面与性能排障

> 存储篇到此结束。至此四篇串成了一条完整的排障链路：**控制面（系列四）→ 调度与 Pod 生命周期（系列一）→ 网络连通性（系列二）→ 有状态存储（系列三）**。下一篇（系列四）会回到"整个集群都变慢/不可用"这一最高层视角：apiserver 限流与准入 webhook 自锁、etcd NOSPACE 与慢盘、调度器与控制器队列、kubelet PLEG 与驱逐、HPA 与控制面容量规划。
