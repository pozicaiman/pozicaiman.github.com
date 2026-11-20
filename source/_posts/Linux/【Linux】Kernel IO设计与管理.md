---
title: Linux 内核 IO 设计与管理体系：从 VFS、Page Cache 到 blk-mq 与 io_uring
date: 2026-10-09 18:00:00
categories: [操作系统]
tags: [Linux, 内核, IO, 存储, 性能优化, SRE]
---

> 这是 Linux 内核三部曲的第三篇。内存篇讲"页从哪来、到哪去"，CPU 篇讲"谁该跑、跑了多久"，本篇讲第三个方向：**数据落盘与取回**。一次 read()/write() 穿过 VFS、文件系统、page cache、块层、驱动直到介质，每一层都在做自己的账——缓存的账、一致性的账、队列的账。排障时的绝大多数"磁盘慢"，病灶都藏在这些账本的口径差里。口径基于 5.10 / 5.15 / 6.6 LTS，具体数字以本机源码与实测为准。

---

# 第 1 章：一次 write() 的旅程 - 三层地址空间与四根约束弦

所有 IO 排障的地基，是先回答"这个字节的请求此刻在 stacks 的哪一层"。本章把整条流水线立起来，后续每一章都是在某一层放大镜头。

## 1.1 一个系统调用，五段接力

应用眼里 `write(fd, buf, len)` 是一行代码，内核眼里它是一条五段接力流水线：

```text
应用          write() / fsync()
  │
VFS           系统调用入口，file->f_op 分发（fs/read_write.c）
  │
文件系统      ext4/XFS：把"文件的第 N 字节"翻译成
  │           "盘的某个块"+日志（第 2/6 章）
  │
Page cache    大多数写的真正终点——先改内存，稍后再落
  │           O_DIRECT 跳过这层直插块层（第 4/5 章）
  │
块层          bio→request，队列、调度、合并（第 7-9 章）
  │
驱动/设备     NVMe/virtio/SCSI → NAND 或云盘后端（第 11 章）
```

关键认知在第一段接力就出现：**buffered write 的默认终点不是盘，是 page cache**。`write()` 返回时，数据通常只在内存里（dirty page），落盘是回写线程/内核线程的异步事——这就是为什么"写完掉电丢数据"不是 bug 而是 POSIX 的默认合同，以及 fsync 为什么存在（第 5 章）。

## 1.2 四根约束弦：带宽、IOPS、延迟、一致性

IO 世界的四个独立货币，**混用单位谈性能必然鸡同鸭讲**：

| 约束 | 单位 | 由什么决定 | 典型陷阱 |
| --- | --- | --- | --- |
| 带宽 | MB/s | 并发深度 × 单次请求大小 | 只测大块顺序，小 IO 墙看不见 |
| IOPS | 次/秒 | 完成路径开销（中断/软irq/上下文） | 队列深度 1 时测不出设备上限 |
| 延迟 | us / ms | 介质 + 排队深度（Little 定律） | 均值掩盖尾，P99 才是体感 |
| 一致性 | 语义等级 | barrier/日志/flush 策略 | 跑得快不等于掉电不丢 |

四者两两制衡：带宽靠大请求和深队列堆出来，代价是单请求延迟；IOPS 上限由设备并行度决定，队列打满后延迟非线性飙升（排队论的通用形状，与第 9 章的 queue_depth 直接相关）；一致性最贵——fsync 把异步流水线强行折成同步，一次写变"数据+元数据+屏障"多次设备往返。**性能报告先声明单位，再谈优化**，是本章唯一想立的规矩。

## 1.3 同步与异步、buffered 与 direct：两条正交的路

两对易混淆的概念其实是**两条正交轴**：

```text
轴一 数据何时到用户可见的内存：
  buffered write   拷进 page cache 即返回（快，异步落盘）
  O_DIRECT         绕过 page cache 直达块层（数据库标配）
轴二 何时确认到稳定介质：
  不 fsync         只到 cache，合同=尽力而为
  fsync/fdatasync  强制把"数据+必要元数据"推到设备
  O_SYNC/O_DSYNC   把 fsync 语义焊死在每次 write 上
```

数据库的经典组合是 **O_DIRECT + 自管页 + fsync/WAL**：既不要内核猜缓存策略，又要持久性合同。Linux AIO（io_submit）名义上是异步 direct 读写的老路，但被 io_uring 实质性取代（第 12 章）。

## 1.4 IO 排障的观测底表

与 CPU 篇第 2 章、内存篇第 17 章同款，本篇的三张底表：

```text
宏观   iostat -x 1          设备级：IOPS/带宽/延迟/队列
       /proc/pressure/io    谁在因 IO 而 stalled（第 14 章）
进程   /proc/[pid]/io       单进程读写字节与同步次数
       pidstat -d 1         谁在产生 IO，rchar/dchar 分真假
微观   blktrace / biolatency 请求级延迟直方图与轨迹（第 15 章）
```

三张表各司一职：iostat 看**设备忙不忙**，/proc/[pid]/io 看**谁在制造**，blktrace 看**单个请求卡在哪段**。跳级使用（现场只有 iostat 就断言"盘坏了"）是误诊的主要来源。

> **关键认知**：IO 栈的每层都有自己的"完成"定义。应用层完成=write 返回；page cache 完成=dirty 入账；块层完成=bio 结束；设备完成=介质确认。四个时刻最多相差数秒（回写脏页窗口）。**排障先对齐口径：用户说的"卡"发生在哪一层的完成语义上？**

**本章要点：**

- buffered write 的终点是 page cache 不是盘；"写返回"与"数据安全"之间隔着回写与日志两道门。
- 带宽/IOPS/延迟/一致性是四种独立货币，谈性能先声明单位；四者两两制衡，没有同时最优的旋钮。
- buffered/direct 与 是否 fsync 是两条正交轴，数据库的标准答案是 O_DIRECT + 自管持久化。
- 观测底表三张：iostat 看设备、/proc/[pid]/io 看元凶、blktrace 看单请求；口径不对齐就下结论必错。

---

# 第 2 章：VFS - 把 POSIX 语义翻译成块设备的中介层

VFS 常被当作"一层胶水"略过，但大量"目录一多就慢""open 风暴打满 CPU"的案子，病灶全在 VFS 的路径解析与缓存语义里。

## 2.1 四大对象：superblock、inode、dentry、file

```text
superblock   每挂载点一个：文件系统类型、脏页账、
             回写线程、根 dentry（fs/super.c）
inode        每文件一个"身份证"：权限/大小/块指针/
             i_mapping 指向 page cache 的 address_space
dentry       路径名→inode 的缓存条目，构成目录树
             （dcache），可丢弃可重建，不落盘
file         一次 open 的"游标对象"：f_pos、f_flags、
             f_op；同一文件被 open N 次有 N 个 file
```

四者关系里最容易误读的是 **dentry 的"可丢弃性"**：目录树本身不持久化，它是路径字符串到 inode 的缓存。冷启动、drop_caches、内存压力下，路径解析会退化成一串真实的磁盘 readdir/lookup——**"重启后第一次访问慢"多半不是设备慢，是 dcache 冷了**。

## 2.2 指针链：从 fd 到磁盘块

```text
用户态 fd（int 下标）
  └─ task->files->fdt->fd[fd]  → file
       ├─ file->f_op / f_pos / f_flags
       ├─ file->f_path.dentry  → 目录树位置
       │     └─ dentry->d_inode → 磁盘身份证
       └─ file->f_inode ─ 同上（链接）
  inode->i_sb        → superblock → 挂载 → 块设备
  inode->i_mapping   → address_space = page cache 数据账本
```

每次 read 的查找成本主要花在三处：fd 表（常数）、路径 dentry（缓存命中则常数）、**逻辑块→物理块映射**（ext4 extent/XFS b+tree，第 6 章）。第三条经常被忽略：文件碎、extent 多，VFS 之后的映射查找本身就制造 CPU 开销——"盘不忙但读慢"的一类隐性来源。

## 2.3 路径解析：path_lookupat 与 RCU-walk

路径 `/a/b/c` 的解析逐级做 dcache 查找；miss 时进入 ref-walk（拿引用计数、可睡眠、可触发磁盘 lookup）。内核提供一条快车道：

```text
RCU-walk（无锁）：全程不拿 dentry 引用，靠 RCU 保证
  不悬垂；任一时刻目录被改动/需要睡眠 → 回退 ref-walk
  代价：中途回退要重头再来，但命中率极高时省掉全部锁
  （fs/namei.c，try_to_walk_with_rcu，细节以本机源码为准）
```

对排障的意义：海量 stat/open 的路径解析是**纯 CPU 行为**（dcache 热）与 **IO 行为**（冷）的混合体。`sy` 高而 `wa` 不高的大 stat 场景，先想锁和哈希（dentry_lock/目录 inode 锁），别先想盘。

## 2.4 负 dentry 与 stat 风暴

dcache 不仅缓存"存在"，也缓存"不存在"——**负 dentry**：查过的不存在路径会留下标记，避免重复下盘。副作用是"探测式循环"（反复 access 不存在文件）在热态几乎免费，但负 dentry 大量堆积占用内存与哈希桶。

stat 风暴的真实成本在锁竞争不在 IO：同一目录下海量文件的 stat，每个都要拿该目录 inode 的锁做 lookup。K8s 节点上监控 agent 递归 stat 整棵容器 rootfs，把单核 `sy` 打到饱和而设备 0 IO，就是教科书案例（处置：白名单采样、降低扫描频率、用 fanotify 替代轮询）。

## 2.5 挂载与命名空间：一层目录可能是一棵树

mount namespace 让不同进程看到不同文件系统视图；overlayfs 把一个目录"叠"在多个 lowerdir 上（容器 rootfs 的标准实现，第 13 章专讲）。VFS 层视角的意义：**同一个路径字符串，在不同 namespace/挂载配置下解析出的 inode 链完全不同**——排障时对比进程要读 `mountinfo`，不能拿宿主的直觉去猜容器内的路径落点。

> **关键认知**：VFS 不产生性能，VFS 决定性能账记在哪层。路径解析慢记在 CPU（锁/哈希），目录树冷记在 IO（readdir），映射碎记在文件系统层。同一个"打开慢"，三种处方。

**本章要点：**

- superblock/inode/dentry/file 四本账分工不同；dentry 可丢弃，冷 dcache 让"重启后首次访问"变成真 IO。
- 一次 read 的查找=fd+dcache+块映射三段；extent 碎带来的映射查找 CPU 成本常被漏记。
- 路径解析走 RCU-walk 快车道，miss 才回退；stat 风暴烧的是目录锁，不是盘。
- 容器时代先读 mountinfo 再谈路径；同一字符串在不同 namespace 是不同 inode 链。

---

# 第 3 章：fd 与 file 对象 - 资源泄漏账本与语义开关矩阵

fd 是 IO 世界的句柄货币。fdtable 决定"开文件贵不贵"，open flags 决定"这次写什么语义"——两本账都容易欠，欠账的表征完全不同。

## 3.1 fd 是下标不是指针：fdtable 结构

```text
task->files（共享表，clone CLONE_FILES 时同表）
  └─ fdtable：fd 数组（下标即编号）+ bitmap（占用图）
  扩容路径：nr_open 上限（默认旧软限 1048576，
  可 sysctl fs.nr_open 调）→ 数组按页分配翻倍
```

fd 编号从低位复用，**"fd=12345 泄漏"的排查别用 pidfd/inotify fd 的编号做长记忆**——编号会被复用，身份要靠 fdinfo。`cat /proc/[pid]/fdinfo/<n>` 给出 flags 和 pos，配合 `/proc/[pid]/fd` 的符号链接（→ 具体路径或 anon_inode: 类型）才能给泄漏定罪。

## 3.2 fd 泄漏观测：数量账与速率账

```bash
ls /proc/[pid]/fd | wc -l          # 总数：快照对比
cat /proc/[pid]/status | grep -i filesys  # 不是它，看 FDSize
pidstat -d -p [pid] 1              # 先排除"高 IO 但没泄漏"
ss -p -t / -u -p --pid [pid]       # socket fd 也是 fd，常混淆
```

判读纪律：**总量单调涨=泄漏，速率尖峰=突发行为**；泄漏账看单调性（小时级快照差），突发账看相关性（与哪个业务事件对齐）。socket 与 eventfd/timerfd 计入同一表——"fd 用满 EMFILE"的元凶未必是文件，先看 fdinfo 类型分布。容器里注意默认 `ulimit -n` 常为 1024/1048576 两派，高并发服务没调上限就是定时炸弹。

## 3.3 open flags 语义矩阵

| flag | 写路径 | 返回时机 | 代价与用途 |
| --- | --- | --- | --- |
| 默认 buffered | 拷入 page cache | 立即 | 快；持久性靠回写+fsync |
| O_DIRECT | 绕过 cache 直达块层 | 提交后 | 需对齐；数据库自管缓存 |
| O_SYNC | 数据+全部元数据落稳 | 设备确认后 | 每次 write 附赠 fsync |
| O_DSYNC | 数据+相关元数据落稳 | 设备确认后 | 比 O_SYNC 省元数据 flush |
| O_NOATIME | 不更新访问时间 | - | 省一次 inode 写；跨 fs 慎用 |

O_NOATIME 常被拿来"优化读多写少目录"：atime 更新默认关闭（relatime 挂载）的现代系统里收益趋零，而它要求属主或 CAP_FOWNER，误用导致备份语义出问题。**矩阵里真正重要的差异在 O_SYNC/O_DSYNC：两者都把异步流折成同步流，一次写变多次设备往返——性能报告里出现它们的名字，延迟预算要重算。**

## 3.4 O_DIRECT 的真实语义：三个常见误解

1. **O_DIRECT ≠ 绕过一切缓存**。它绕过 page cache，但**绕不过设备易失缓存**：掉电合同仍要靠 fsync/barrier（第 5 章）；也绕不过 dentry/inode 层。
2. **O_DIRECT 有对齐税**。缓冲区地址、长度、文件偏移都按逻辑块对齐（老内核按块，新内核可声明部分对齐，能力位 `O_DIRECT_ALLOW_UNALIGNED` 类以本机为准）；小 IO 随机写会放大成读改写（RMW），NAND 上尤其贵。
3. **O_DIRECT 不等于真异步**。传统 read()/write() 即便 O_DIRECT 仍是同步等待；异步要靠 io_submit 或 io_uring（第 12 章）。

> **关键认知**：O_DIRECT 是"缓存决策权的移交"——内核不再替你猜，全部责任（对齐、并发、落盘确认）回到应用。数据库用它是买确定性，不是买速度；用错它的系统，通常比 buffered 更慢还更难排障。

**本章要点：**

- fd 是 fdtable 数组下标，编号会被复用；泄漏定罪靠 fdinfo 类型+pos，不靠编号记忆。
- 泄漏账看单调性、突发账看相关性；socket 也占 fd 表，EMFILE 元凶未必是文件。
- 语义矩阵的轴心是"返回时机"：buffered 立即、O_DIRECT 提交后、O_SYNC/O_DSYNC 设备确认后。
- O_DIRECT 移交的是缓存决策权不是落盘合同；对齐、RMW、伪异步三个税都要进预算。

---

# 第 4 章：Page Cache 读路径 - 预读的艺术与翻车现场

内存篇第 8 章建了 page cache 的账本（address_space、xarray、脏页标记），本章从 IO 视角读它：**一次 read miss 之后，内核如何决定读多少、什么时候读、替不替你读**。

## 4.1 filemap_read 的三段旅程

`read()` 进入 `generic_file_read_iter → filemap_read`（mm/filemap.c 概念路径），对每个页号：

```text
命中   xarray 查到 Uptodate 页 → 拷贝返回（零 IO）
在途   查到页但 !Uptodate → 睡眠等同一页的读完成
       （read 合并的免费午餐：后来者白拿前人发起的 IO）
未命中 自己发起：分配页 → 提交 bio → 等完成 → 拷贝
```

"在途"分支值得强调：**多个线程读同一页不会发起两次盘 IO**，页锁把并发改成一次读+多人等。随机小文件高并发重复读的性能曲线因此比直觉平滑；但也意味着单页 IO 延迟直接变成所有等它线程的延迟。

## 4.2 预读状态机：窗口从 16 页长到 cap

顺序模式检测与窗口自适应（mm/readahead.c，具体数值以本机源码为准）：

```text
起点   首个 miss：按文件/设备提示决定初始窗口
       （常见起点 16 页 = 64KB 量级；bdi->ra_pages 为上限）
加速   连续"恰好读到窗口尾" → 窗口翻倍，直到 ra_pages
异步   读过半窗 → 提前唤醒后台流读后半（async_mmap/
       do_async_mmap 之外的 do_sync_mmap_readahead）
刹车   请求不在窗口内（随机） → 窗口坍缩、退回逐页读
```

预读的钱从哪来：`posix_fadvise(WILLNEED)`、mmap 缺页路径、以及内核自身对顺序检测的信任。**预读本质是用"可能浪费的带宽"换"确定性省掉的往返"**——在延迟敏感的 NVMe 上这个交换往往亏本（第 4.3 节），在机械盘/云盘高延迟上稳赚。

## 4.3 预读翻车的三种典型

1. **随机读被打上顺序标签**：数据库按固定顺序翻页（逻辑随机、物理顺序假象）触发预读，带宽被抢、关键页延迟被排队拖高。处方：O_DIRECT 或 `random read` 模式检测（bfq 的异步判定，第 8 章）。
2. **小文件连读**：每个文件都从初始窗口起步，预读永远刚起步就换文件。海量小文件场景（构建机、相册缩略图）的"盘忙但吞吐低"多为此。处方：合并访问、增大顺序度，而非加队列。
3. **文件尾部越界计算**：窗口按倍数扩张撞上 EOF，旧内核曾出现尾部重复读/零页处理低效（版本差异大，以本机行为为准）。处方：fadvise 精确提示或 DIO 收尾。

## 4.4 读路径的观测账本

```bash
# 进程账：rchar 是"逻辑读了多少"，read_bytes 是"真下了多少盘"
cat /proc/[pid]/io    # 两者差额=page cache 命中率的钱
# 全局账
grep -E '^cached' /proc/meminfo
cat /proc/vmstat | grep -E 'pgpgin|pgmajfault'
# 块层账：读请求的合并在 blktrace 里看（第 15 章）
```

`rchar >> read_bytes` 是健康的缓存命中；`rchar ≈ read_bytes` 且都高，说明读路径根本没吃到 cache 红利——要么工作集超内存（回内存篇回收章），要么应用主动 O_DIRECT，要么每读一次就丢（重复读同文件不涨 cache，怀疑 open 后立即 fadvise DONTNEED 的框架行为）。

## 4.5 read、mmap、O_DIRECT 的三选一

| 方式 | 拷贝次数 | 页决策权 | 适合 |
| --- | --- | --- | --- |
| read buffered | 盘→cache→用户 2 次 | 内核（预读/回收） | 通用、重复读、流式 |
| mmap | 缺页时 1 次（按需） | 内核（页表/LRU） | 大文件随机片段、数据库式自管 |
| O_DIRECT | 盘→用户 1 次 | 应用 | 已有自管缓存、要落盘合同 |

mmap 的隐性账：缺页把读延迟藏进指令执行里（CPU 篇第 11 章的换页故事在此汇合），且预读走 `do_sync_mmap_readahead` 的独立窗口逻辑；**mmap 慢排查要同时翻 CPU 账和 IO 账**，只看 iostat 会漏诊（major fault 计数是桥，pgmajfault）。

> **关键认知**：page cache 读路径的一切优化都建立在一个信任假设上——"过去连续读，未来还会连续"。预读翻车的本质是假设破产：窗口越大，猜错的代价越大。数据库绕开它不是嫌它慢，是不接受"内核替你赌"。

**本章要点：**

- 一次 read 对每页走命中/在途/未命中三支，同页并发读天然合并成一次盘 IO。
- 预读窗口从初始值翻倍到 ra_pages，随机即刹车；本质是带宽换往返次数的对赌。
- 翻车三现场：假顺序、小文件连读、EOF 撞窗；NVMe 低延迟设备上预读常是负资产。
- rchar 与 read_bytes 的差额量出缓存红利；mmap 读延迟藏在缺页里，观测要跨 CPU 与 IO 两篇。

---

# 第 5 章：写路径与持久性契约 - dirty、节流与 fsync 的三道闸门

## 5.1 write() 的两副面孔：缓冲与合同

read 路径拼的是延迟，write 路径拼的是**承诺**。POSIX 对 write() 的实际合同只有一句话：返回成功即数据进入页缓存、对后续读者可见——**不包含掉电不丢**。掉电语义要靠显式动作（fsync/fdatasync/O_SYNC）购买，而每一次购买都在延迟上记账。写路径的三层地址空间（第 1 章）在写方向变成三扇闸门：

```text
 write()          回写线程            fsync()
    |                 |                  |
    v                 v                  v
 [闸门1]         [闸门2]           [闸门3]
 用户->页缓存    脏页->提交bio      盘缓存->盘片
 (memcpy量级)    (受节流与超时)     (FLUSH/FUA等待)
```

排障时先把现场落到某一层：**"write 慢"三个字至少要拆成"页缓存慢（节流）""提交慢（设备队列满）""落盘慢（fsync 等 FLUSH）"三种病**，用药完全不同。

## 5.2 脏页账本：两级水位与过期时间

脏页不是无限堆积的，内核用一组水位线控制总量（`mm/page-writeback.c`）：

- `vm.dirty_background_bytes/ratio`：越过即唤醒回写线程**后台**擦黑板，不挡写入者。
- `vm.dirty_bytes/ratio`：越过即让**写入者本人**停笔——`balance_dirty_pages()` 把当前任务挂起直到水位回落，这就是**节流（throttle）**。
- `vm.dirty_expire_centisecs`（默认 30 秒）：脏页最迟在这个年龄前回写，是"突发写完后的余震"来源——压力停了 iostat 还在冒 wr/s，就是过期定时器在扫尾。
- `vm.dirty_writeback_centisecs`（默认 5 秒）：回写线程的巡检周期。

账本分两级：全局一个 `nr_dirty`，每个 bdi（backing device info，一块可写设备一份）各有一本。cgroup v2 用 `io.max` 里的 `rbps/wbps` 之外，还有 `memory.dirty_bytes` 与 bdi 的 `max_ratio`（`/sys/class/bdi/<dev>/max_ratio`）共同约束单个 cgroup 在某块盘上能脏多少——**一个容器脏页超限，节流只打在这个容器的任务上**，这是 5.10+ 容器写隔离的地基。

> **关键认知**：节流的现场极具迷惑性——任务睡在 `balance_dirty_pages`，**不在 D 态而在可中断睡眠**，`ps` 状态是 S；iostat 上 wr_await 可能很好看，因为 bio 根本没提交，慢发生在提交之前。**"写慢但设备不忙"第一反应应该是查节流，不是查盘。**

证据链：

```bash
# 全局脏页与水位
grep -H . /proc/sys/vm/dirty_ratio /proc/sys/vm/dirty_background_ratio
grep -E 'Dirty|Writeback' /proc/meminfo
# 某块的脏页账本与节流统计
cat /sys/class/bdi/nvme0n1/max_ratio /sys/class/bdi/nvme0n1/read_ahead
# 谁在被节流：ftrace 事件（5.x 有 balance 相关 tracepoint）
cd /sys/kernel/debug/tracing
cat events/writeback/balance_dirty_pages/enable
```

（writeback tracepoint 组还有 `dirty_task_start/end`、`writeback_single_inode`，打开后 `trace_pipe` 能直接看到"哪个任务、为哪个 inode、睡了多久"，5.10/5.15/6.6 事件名基本一致，以本机源码树 `include/trace/events/writeback.h` 为准。）

## 5.3 回写的三个扳机

bio 提交时机只有三个来源，理解它们就理解了一半的"莫名其妙抖动"：

1. **超时**：每 5 秒巡检一次，把年龄超过 30 秒的脏页刷下去——突发写入后的余震。
2. **水位**：超过 background 线后台刷，超过 dirty 线写入者边睡边刷。
3. **显式**：fsync/fdatasync/sync/`sync_file_range`/内存回收（第 14 章会与回收耦合）。

回写的组织单位是 inode（`writeback_single_inode`），一个文件写得很猛，它的脏页在 address_space 的 radix tree（5.14 后为 xarray）上按页号聚合，回写按窗切 bio。**海量小文件同时脏**是回写风暴的典型源：每个 inode 一轮单点回写，磁盘看到的是随机小写洪峰。

## 5.4 fsync 的完整语义：内核到底替你做了什么

`fsync(fd)` 在 ext4 上的实现链（`vfs.c: do_fsync -> ext4_fsync -> jbd2_complete_transaction` 一族），语义拆开是四步：

1. 把该 inode 的脏数据页全部提交为 bio 并**等待完成**（`filemap_write_and_wait_range`）。
2. 把元数据写入日志（journal），保证事务落盘（第 6 章）。
3. 如果设备带**易失写缓存**，发 FLUSH/FUA 命令把盘内缓存排干并等待（`blkdev_issue_flush`）。
4. 返回。此时断电，数据可按日志重放恢复。

`fdatasync` 省掉第 2 步里"与该文件数据无关的元数据"（如 atime、不影响读回的文件尺寸外元信息），对纯改数据的文件能省一次日志提交——数据库常用。

**常见误解校准**：

- fsync 返回 ≠ 数据在盘片上，是"**已在持久介质或可按日志恢复**"。盘子固件撒谎是另一层事故（企业盘有电容保护，消费级 SSD 掉电可能丢已确认写入）。
- 两次 fsync 之间写 1GB 与写 1KB，第 1 步耗时天差地别——fsync 成本≈把该 inode 当前脏页全部刷完的成本，不是固定开销。
- O_APPEND+O_SYNC 的每次 write 都走一遍全套闸门，**同步追加日志是性能黑洞**，典型处方是改 buffered + 批量/定时 fsync。

## 5.5 barrier 与 FUA：写缓存的最后一块拼图

磁盘/SSD 普遍带 volatile write cache，承诺顺序可能不成立——断电时盘缓存里的数据排在盘上旧数据前面。内核用两种手段对冲（`drivers/nvme`、`block/blk-flush.c`）：

- **FLUSH（barrier）**：先排空缓存再放行后续，代价是**把后续 IO 全堵住**（队列效应）。
- **FUA（Force Unit Access）**：单条写穿透缓存直达介质，不堵队列，但可能慢一截。

设备能力在 `/sys/block/<dev>/queue/write_cache`（`wt`/`wr`）与 `fua` 位可见。ext4 挂载参数 `barrier=0`（旧内核 `nobarrier`）是对 RAID 卡电池缓存的信任状——**只有下游真有 BBU/NVRAM 才能关，否则 fsync 的合同被悄悄作废**。

## 5.6 新文件的 POSIX 陷阱：目录也要 fsync

fsync(fd) 保证的是**这个 inode** 的数据与元数据进日志；但"文件名在目录里的这条目录项"是**父目录 inode 的元数据**，可能还躺在页缓存。断电后文件内容完好、名字没了。数据库与存储引擎的标准做法是**写完文件 fsync 文件，rename/新建后 fsync 目录 fd**；更省的路径是用 `RENAME_NOREPLACE` 前预建文件、或用 `open` 时 O_SYNC 目录句柄，视需求取舍。

```c
/* 掉电安全的落盘顺序（以新建文件为例） */
fd = open("/data/tmp/obj-42", O_WRONLY | O_CREAT, 0644);
write(fd, buf, len);
fsync(fd);            /* 数据与inode进日志 */
close(fd);
dfd = open("/data/tmp", O_RDONLY | O_DIRECTORY);
fsync(dfd);           /* 目录项落盘 */
rename("/data/tmp/obj-42", "/data/obj-42");
fsync(dfd);           /* 再次：目录项改名 */
```

> **关键认知**：一致性成本可以延迟但不能消灭。fsync 的等待里，1 次是 memcpy 的清算（脏页回写）、1 次是日志提交、1 次是 FLUSH/FUA——三段各有各的病：脏页多→慢在回写；日志小盘慢→慢在提交；消费级 SSD→慢在 FLUSH。**先分清慢在哪一段，再谈优化。**

**本章要点：**

- write 的合同只到页缓存；fsync 才买掉电语义，成本≈脏页回写+日志提交+FLUSH 三段之和。
- 脏页受 background/dirty 两级水位与 expire 超时控制；越过 dirty 线写入者被节流，睡在 S 态不在 D 态。
- "写慢但设备不忙"优先查节流：/proc/meminfo 的 Dirty、bdi 账本、writeback tracepoint。
- FLUSH 堵队列、FUA 不堵；barrier=0 只能换给带电池缓存的下游。
- 新文件掉电不丢名字必须 fsync 父目录，这是应用合同不是内核默认。

---

# 第 6 章：文件系统内部 - ext4 的 jbd2 与 XFS 的延迟分配

## 6.1 日志为什么存在：从 fsck 到 redo

无日志文件系统崩溃后靠 fsck 全盘扫一致性——分钟级、且修不回"被截断的元数据"。日志的思路是**先写意图，再改现场**：元数据变更先以 redo 记录写进 journal，崩溃后重放日志即可回到"事务要么全发生要么没发生"的状态。ext4 的日志实现是 jbd2（`fs/jbd2/`），XFS 的日志独立实现且元数据全部走延迟事务模型；**日志只保护元数据**（ext4 另有 data=ordered/writeback 模式处理数据页与事务的关系，见 6.5）。

## 6.2 jbd2 事务生命周期：一次 fsync 在内核里的完整一生

以"创建一个文件并 fsync"为例，jbd2 的账本（`fs/jbd2/transaction.c`）：

```text
 handle 1: journal_start ---+
 handle 2: journal_start    |  同一时间窗的 handle
   ...                      +-> 都记在当前 running transaction T1
 handle N: journal_stop ----+
        |
        v
 (定时器/攒够阈值/显式fsync 触发) journal_finish(T1)
        |
        v
 写 T1 的 commit record 到 journal -> 等盘 -> 标记 T1 可检查点
        |
        v
 后台 checkpoint：把 T1 改过的元数据块写到"原位" -> 释放 journal 空间
```

关键变量三个：

- **t_handle 计数**：running 事务引用归零才能提交——**一个卡住的 handle 会拖死整批提交**，这是 jbd2 D 态案例的根（6.3）。
- **提交由三件事触发**：`fsync` 显式踢一脚、日志空间用到阈值、5 秒周期（与回写巡检同频）——**没有 fsync 的元数据更新最快也要等约 5 秒才进日志**，这是 `data=ordered` 下"rename 后立刻断电可能看不见"的时间窗来源。
- **checkpoint 是第二笔延迟账**：日志不是无限大的，写满前必须等旧事务的原位块落盘腾出空间——**checkpoint 慢会反压新事务提交**，表现是周期性的 fsync 尖刺。

## 6.3 jbd2 卡住的现场：D 态栈与证据链

典型栈（5.10 常见形态，函数名随版本微调）：

```text
 任务 A:  ext4_sync_file -> journal_stop -> wait_for_commit
 任务 B:  ext4_writepages -> journal_start -> 事务太满等待
 jbd2线程: journal_commit_transaction -> 等 FLUSH/等 checkpoint
```

三行栈读出的因果：**A 的 fsync 在等 B 参与的同一笔事务，而整个事务卡在设备 FLUSH 或 checkpoint 上**。观测抓手：

```bash
# jbd2 进程自身状态与等待点
ps -eo pid,stat,wchan:32,comm | grep jbd2
# 每设备的 journal 与 checkpoint 节奏（tracepoint）
cat /sys/kernel/debug/tracing/events/jbd2/jbd2_checkpoint_stats/enable
# ext4 超级块日志状态
cat /proc/fs/ext4/nvme0n1p1/options
```

**处置梯度**（按代价从低到高）：确认盘/缓存 FLUSH 慢→换带 FUA 的企业盘或开 RAID BBU 后 `barrier=0`；确认 checkpoint 反压→增大 journal（mkfs 时 `journal_size`）或换更快的 journal 设备；日志本身不是瓶颈而 handle 泄漏→查 ext4 的 truncate/大事务路径，升级到 5.15/6.6（jbd2 在多版本上修过若干 commit 路径回归）。

## 6.4 XFS：延迟分配与它的两面性

XFS 与 ext4 最大的设计分歧是 **delayed allocation**：写脏页时**不落盘块**，直到回写才由 XFS 一次性申请整段连续_extent_。收益是分配时机晚、能看到全貌，碎片少、大顺序写多；代价是：

- **预分配语义变化**：fallocate 之后数据没落块，`du` 与 stat 的块数对不上——**备份/配额工具按块数算账会误判**。
- **写后崩溃的暴露面**：数据页还在内存、块还没分配，fsync 之外的数据丢了就是丢了（ext4 同样丢，但 XFS 连"块在哪"都还不知道）。
- **EOF 空洞**：写偏偏移量大的稀疏文件时，未落盘的 delayed extent 崩溃后消失，文件显得"更稀疏"。

XFS 的元数据变更全部走**事务（log items）**，没有 ext4 的 data=ordered 概念——数据页进不进日志由 `writepages` 路径保证与事务顺序（6.5 对照）。XFS 的日志在 5.10+ 支持 **intent item 重构（log items 重放顺序修复）**，6.6 上稳定性更好；在线扩容、reflink 是其特色。

## 6.5 ext4 的 data 模式与一致性-性能旋钮

| 模式 | 数据页与事务的关系 | fsync 强度 | 风险 |
|---|---|---|---|
| data=journal | 数据也写日志（双写） | 最强 | 性能最差 |
| data=ordered | 数据先落盘、再提交日志 | 默认 | 崩溃后见旧数据/空洞 |
| data=writeback | 数据与日志无关 | 最弱 | 可能读到已释放块 |

挂载参数还有 `commit=N`（秒，默认 5）控制提交周期；`stripe=` 影响 bio 切分与日志布局；`nobarrier/barrier=` 如 5.5 所述。**`data=writeback + nobarrier` 的组合在测试基准里常见，生产上等于把"崩溃一致性"的合同撕掉两页。**

> **关键认知**：文件系统层的持久性全是**两阶段**的——先写意图（日志）、后改现场（checkpoint）。于是排障也永远是两个嫌疑时段：**提交前**（事务攒着，fsync 在等 handle 归零）与**检查点后**（原位写引发二次 IO 洪峰）。iostat 上 jbd2 设备出现"应用没写、盘在写"的窗口，多半是 checkpoint；出现"应用猛 fsync、提交不动"的窗口，多半是日志 FLUSH 慢。

**本章要点：**

- 日志=先写意图再改现场；只保元数据，崩溃靠重放，代价在 checkpoint。
- jbd2 提交由 fsync/日志阈值/5 秒周期触发；一个卡住的 handle 拖死全批提交。
- jbd2 现场看三行栈：应用在等提交、写者在等事务、jbd2 在等 FLUSH/checkpoint。
- XFS 延迟分配少碎片、但 du/配额/稀疏 EOF 语义变脆。
- data=ordered 是默认折中；writeback+nobarrier 测试参数不是生产合同。

---

# 第 7 章：bio 与 blk-mq - 块设备层的排队艺术

## 7.1 bio：块层的通用货币

过了文件系统，一切 IO 都变成 **bio**（block IO，`include/linux/blk_types.h`）：一个 bio = 起始扇区 + 一组内存页片段（`bi_io_vec`，每项是 page+offset+len）+ 方向与标志（FUA、SYNC、DISCARD）。要点三条：

- **bio 不是盘上命令**：NVMe SSD 的硬件命令只认单段连续地址，多 vec 的 bio 在下发前常被拆成多个 request/nvme 命令——`iostat aqu_sz` 里的"队列深度"与硬件真实 QD 不是一回事。
- **sector 与页不对齐是常态**：4K 块设备扇区上读写 512B 对齐的 POSIX 边界，块层看不到"半个页"的问题，但**设备缓存上的 read-modify-write（RMW）放大**从这里开始（第 11 章 WAF）。
- **bio 的合并发生在 request 层**（7.5），不在 VFS——两个进程各写相邻 4K，page cache 各脏一页、回写各一个 bio，块层才有机会把它们拼成一个 request。

## 7.2 legacy 为什么死：一把全局锁撑不住 100 万 IOPS

2.6 时代的请求队列模型：每个 gendisk 一个 `request_queue` + 一把自旋锁，所有 CPU 的 bio 进来排队、排序、出队。**HDD 时代够用**——瓶颈在毫秒级寻道；NVMe 把服务时间压到 10 微秒级后，**多核并发打满一块盘时，锁的争抢比盘还慢**，CPU 烧在 `native_queued_spin_lock_slowpath` 上而 IOPS 上不去，这是 legacy 的死因。blk-mq（3.13 引入，4.x 成为唯一路径，`block/blk-mq.c`）的答案是**把队列做成 per-CPU 的**。

## 7.3 blk-mq 的三层结构

```text
 CPU0 任务            CPU1 任务
   |                    |
 sw-queue 0          sw-queue 1      (per-CPU 无锁入队)
   |                    |
   +--------> sbitmap <--------+     (tag 位图：并发许可证)
                |
        hw-queue 0 / 1 / 2 ...       (对应设备硬件队列)
                |
           NVMe SQ/CQ 对
```

- **sw-queue**：软件侧 per-CPU（或 per-hctx 多队列）暂存，入队基本无锁。
- **hw-queue（hctx）**：映射到设备的真实硬件提交队列；CPU→hctx 的映射由硬件中断亲和决定，**跨 NUMA 的 hctx 映射会白白多一跳**（`/sys/block/<dev>/mq/<n>/cpulist` 可查）。
- **sbitmap（tag）**：每个 in-flight request 占一个 tag，tag 用完就等——**tag 是块层的"并发深度许可证"**，`/sys/block/<dev>/queue/nr_requests` 只是软上限，NVMe 的真实 tag 数在驱动（队列大小-1，扣掉保留）。

调度器插在哪里：**sw-queue 之后、dispatch 到 hw-queue 之前**——所以 `none` 之外的调度器都要为每个 hctx 维护自己的数据结构，这也是换调度器不用重挂盘、只影响排序/合并策略的原因。

## 7.4 tag 分配不均：NVMe 读写互饿的经典案

驱动可以为不同优先级保留 tag（NVMe 队列的 tag 静态划分，`drivers/nvme/core.c` 按写/读分 reserve）。现场形态：**读打满后，写请求拿不到 tag，fsync 排队秒级**。证据在：

```bash
# 每 hctx 的 in-flight 与 tag 上限（名字随版本略有差异）
cat /sys/kernel/debug/block/nvme0n1/hctx0/tags
# 队列层直接计数
grep -H . /sys/block/nvme0n1/queue/nr_requests
```

处置：应用侧限并发（第 12 章 io_uring 的 SQE 窗口本身就是阀门）；或升级内核（6.6 对 tag 静态保留的均衡逻辑有改动，以本机源码为准）；云盘场景则多为**盘级 IOPS 配额在 hypervisor 侧排队**，guest 的 tags 永远拿得到，`aqu_sz` 高但 `%util` 也高——这是第 10 章的误区素材。

## 7.5 合并：front、back 与调度器窗口

入队时的三种合并（`blk-merge.c`）：**front merge**（新 bio 贴到某 request 尾部，扇区号衔接）、**back merge**（贴头部）、以及调度器出队时的**再排序合并**。合并率看 `iostat -x` 的 `r/s+w/s` 与应用 `bios` 计数差（`/proc/<pid>/io` 的 `syscr/syscw` 是系统调用，`bio` 行才是块层提交数）：**应用 write 次数 ≫ bio 次数 = 合并吃掉了小 IO**；两者接近 = 合并失效（随机分布或 `none` 调度器）。

> **关键认知**：blk-mq 之后，"IO 队列"这个词至少有三层含义——sw-queue 的批次数、tag 的 in-flight 数、硬件 SQ 的深度。**iostat 的 aqu_sz 只是 request 层的平均在途数，不等于硬件队列深度**；NVMe 多队列下它把 N 个 hctx 摊平成一个平均数，设备明明在满负荷并行，aqu_sz 可能显示"很浅"。数字没有错，口径错位才是排障时最大的坑。

**本章要点：**

- bio 是块层通用货币；多 vec bio 会被拆成硬件命令，队列深度口径要分三层。
- legacy 死于全局锁；blk-mq 用 sw-queue+sbitmap+hw-queue 实现 per-CPU 无锁入队。
- tag 是并发许可证，读写分池不均会造成"读饿写"；debugfs block tags 可见。
- 合并发生在 request 层；syscw 与 bio 计数的差额就是合并红利。
- aqu_sz 是 request 层平均值，不反映 NVMe 多硬件队列的真实并行深度。

---

# 第 8 章：IO 调度器 - 在公平、吞吐与延迟之间选边

## 8.1 调度器的不可能三角

块层调度器同时只能讨好两样：**吞吐**（排序、合并、批量提交）、**公平**（按权重/按 cgroup 分配带宽）、**延迟**（读不被写埋、超时不饿死）。HDD 时代排序免费提升吞吐，调度器是必需品；SSD/NVMe 时代寻道消失，**排序的收益缩小、延迟开销变成纯成本**——这就是 `none` 存在且常被推荐的根因。四个选项的能力矩阵：

| 调度器 | 强项 | 弱项 | 典型场景 |
|---|---|---|---|
| none | 零开销 | 无延迟保护 | NVMe/云盘+应用自管并发 |
| mq-deadline | 读延迟保护 | 公平性弱 | HDD/普通 SSD |
| kyber | 目标延迟自适应 | 高深度下抖动 | 快速 SSD 混合负载 |
| bfq | 权重公平 | CPU 开销大 | 桌面/多租户同盘 |

## 8.2 mq-deadline：两张截止期队列的极简主义

核心是一读一写两条 FIFO（按扇区号排序的 dd_queue）+ 截止期：读默认 500ms、写默认 5s（`read_expire`/`write_expire` sysfs）。到期后插入"过期批次"优先派发，写还配 `writes_starved`（默认 2：每服务 2 批读才允许 1 批过期写插队，防写饿死）与 `frontpages`（合并窗口向前扩展的页数）。**它假设盘是慢的、乱序是便宜的**——用在高端 NVMe 上，排序与窗口合并的 CPU 成本未必划算。

## 8.3 kyber：用令牌把延迟钉在目标上

kyber 不排序，只做**延迟反馈**：对读/写/其他三类流量维持 in-flight 令牌，定期用"当前批次的最小/平均完成时间"对目标（默认读 5ms、写 7.5ms，sysfs `burst_latency_ns_target`）做乘性调整——**快就放量、慢就收流**。适合云盘（延迟由 hypervisor 抖动决定，kyber 能自动退避）；缺点是不保公平，两个猛对打的进程它不管。

## 8.4 bfq：唯一的"权重"调度器

bfq 为每个 active 队列（进程/线程组）建实体，按 `io.weight`（cgroup v2 的 `io.weight` 或 bfq 的 per-cgroup 权重）做加权公平排队，附带**时间切片**（idle 窗口）判定顺序流与随机流、并对顺序流做大请求合并。代价：红黑树+大量状态机，**CPU 税显著**（高 IOPS 下可达百分之几核）。第 4 章埋的伏笔在此兑现——**bfq 判定"异步流"会给予顺序保护，但它的 async 判定在海量短连接小 IO 上会误判为随机，反而放弃合并**，这是"切 bfq 后吞吐大跌"的一类成因。云盘多租户场景 bfq 表现也不稳定（后端已排队，前端权重是叠床架屋）。

## 8.5 切换与验证

```bash
# 查看当前与可选
cat /sys/block/nvme0n1/queue/scheduler
# 切换（立即生效，无需重挂）
echo mq-deadline > /sys/block/nvme0n1/queue/scheduler
# 持久化：内核参数 io_scheduler.<dev>= 或 udev 规则写 scheduler
```

版本口径：5.10/5.15/6.6 均默认 **mq 路径**，`bfq` 自 5.0 起重写进 blk-mq；老文档里 `cfq` 在 5.0 已删除——**内核 ≥5.0 还写"用 deadline 调度器"要确认是 `mq-deadline`**，旧 `deadline` 不复存在。

> **关键认知**：调度器选型是**给"谁有权利插队"立法**，不改变盘的服务能力。判断该不该换调度器的先决问题是：**盘是不是已经是瓶颈？** 若 iostat 显示设备常年满载（`%util`/aqu 高、await 高），换任何调度器都救不了容量问题；若延迟尖刺只出现在读写混跑时刻，deadline/kyber 的读保护才有意义。**先分诊容量与策略，再动调度器。**

**本章要点：**

- 调度器在吞吐/公平/延迟里只能选二；NVMe 上排序收益缩水，none 常是正解。
- mq-deadline 靠读写截止期与 writes_starved；kyber 靠令牌反馈钉延迟。
- bfq 是唯一权重公平调度器，CPU 税高、async 判定会误伤小 IO 合并。
- 切换即时生效（sysfs scheduler），cfq 已死，≥5.0 的"deadline"是 mq-deadline。
- 换调度器前先确认瓶颈是策略还是容量：满载的盘立法救不了。

---

# 第 9 章：队列深度与并发阀门 - 从应用到硬件的漏斗

## 9.1 一条 IO 要过的五道并发闸

"IO 并发"不是一个数字，是五个串联的阀门（`iostat` 之外最容易漏看的地图）：

```text
 应用线程数 / 异步上下文容量      (第1闸: aio-max-nr, io_uring SQ)
   -> 块层 tag / nr_requests      (第2闸: in-flight 上限)
     -> 调度器窗口                (第3闸: 排序与合并的等待)
       -> 硬件队列 SQ 深度        (第4闸: NVMe 队列大小)
         -> 固件内部并行度        (第5闸: 盘自己的并发能力)
```

**性能诊断的意义**：压力上不去时，逐闸看哪一道先满。第 1 闸满=应用加线程有效；第 2 闸满=加 tag 或降单请求大小；第 5 闸满=换盘或限流。**"iostat aqu_sz 不高所以盘不忙"是典型误读**——aqu_sz 量的是第 2 闸的在途，第 5 闸早满了（第 10 章展开）。

## 9.2 queue_depth 与 nr_requests：两个常被混用的旋钮

- `/sys/block/<dev>/queue/nr_requests`：**每队列**可排队 request 上限（默认 128/256/1024，随调度器与驱动变），调大只增"排队容忍"，不增服务能力。
- `/sys/block/<dev>/queue/queue_depth`：SCSI/NVMe 向块层申报的**建议并发**，blk-mq 下主要影响 tag 池规模。
- `/proc/sys/fs/aio-max-nr` 与每进程 `aio-nr`：libaio 上下文的总请求数——**容器里大量 io_submit 失败 `EAGAIN`/`Resource temporarily unavailable` 先查这个全局闸**（MySQL、AIO 数据库重灾区）。

```bash
# 三层计数一次看
grep -H . /proc/sys/fs/aio-max-nr /proc/sys/fs/aio-nr
grep -H . /sys/block/nvme0n1/queue/nr_requests
# 每块盘当前 in-flight（diskstats 第 9 字段）
grep -E 'nvme0n1|sda' /proc/diskstats
```

## 9.3 fio 的 iodepth 教出来的错觉

fio `--iodepth=32 --ioengine=libaio` 的语义是**提交端允许 32 个未完成请求**，但 Linux 上 `io_submit` 进入块层后：若 tag 不足或调度器要求立即派发，**它会在内核里同步等待一个空位**——"异步深度 32"可能实际在途只有 4，其余 28 个睡在 `io_submit` 里。证据方法：比对 fio 报告的 QD 与 diskstats in-flight 列；或用 `blktrace` 看提交-派发间隔（第 15 章）。**"iodepth 调了没反应"的多数答案：瓶颈在前面某一闸，不在提交端。**

## 9.4 cgroup io.max：节流发生在哪一段

cgroup v2 的 `io.max`（`rbps= wbps= riops= wiops=`）在**块层派发前**用令牌桶卡住 request（`block/blk-iocost.c` 与 `blk-throttle.c` 两条路）。被卡的任务现场：`io.delay`/`io.service_time`（iocost）里涨，`io.pressure`（cgroup 自己的 PSI）里 `some` 涨——**而全局 `/proc/pressure/io` 可能几乎不动**，因为 psi io 统计的是"任务因 IO 停滞而全系统无人可跑"的 full 条件（第 14 章细讲）。第 8 章的 bfq 权重是**分配策略**，io.max 是**硬上限**：前者只影响排队先后，后者直接影响吞吐天花板——容器写限流优先用 io.max，别指望 bfq"顺便"隔离。

> **关键认知**：每一层"队列深度"都有**自己的在途计数**，排障时要把五个闸的读数摆在同一张表上再下结论。只摆 iostat 一张表就断言"盘还有余量"，等于只看了漏斗的中段。

**本章要点：**

- IO 并发是五道串联闸：应用、tag、调度器、硬件 SQ、固件；先找先满的那道。
- nr_requests 是排队容忍，queue_depth 是申报并发；aio-max-nr 是全局提交总闸。
- fio iodepth 不等于真实在途；io_submit 会在内核里同步等空位。
- io.max 硬节流在派发前，体现在 cgroup io.pressure；bfq 权重只排先后。
- 结论要五闸同表：单看 iostat 的 aqu_sz 会误判设备余量。

---

# 第 10 章：iostat 的四个误区 - 老仪表盘读不出新盘

## 10.1 %util：为寻道时代设计的指标

`%util` = 设备至少有一个 request 在途的时间占比。HDD 上"在途=在干活"，100% 即真饱和；**SSD/NVMe 上一条 request 在途时固件可以并行服务几十条**——队列里永远有活，`%util` 常年 100% 却远未榨干盘。**NVMe 上 %util 唯一可靠的用法是看它是否不到 100%**（那一定闲）。饱和判断改看：await 是否随 IOPS 上升而拐点、或盘厂商的标称 IOPS/带宽占比。

## 10.2 await：均值掩盖双峰

await 是完成延迟的平均。读写混跑时，读 0.1ms+写 5ms 的混合均值 2ms，会让"读没问题"的错觉成立——**读其实已经被写埋了**。拆法：看 `-x` 的 `r_await/w_await` 分列；仍不够时用直方图（第 15 章 bpftrace 示例）。**云盘的 p99 尖刺在平均值里永远看不见。**

## 10.3 aqu_sz（avgqu-sz）：平均在途的双重欺骗

`aqu_sz = 提交速率 × 平均延迟`（Little 定律），两个坑：其一，它把 NVMe 多个 hctx 摊平成一个数，32 队列并行各 8 深会显示 256 也可能显示"256 里含排队"；其二，**排队也计入在途**——被 io.max 节流、被 tag 卡住的 request 都算 aqu_sz，于是"队列深=盘忙"不成立，**队列深可能只是"有人在门口等"**。与 9.1 对照：aqu_sz 量的是第 2 闸的门口人数。

## 10.4 r/s、w/s、sz：request 口径不是应用口径

iostat 的速率与 `r/s`、`wareq-sz` 按 **request** 计（合并后），`/proc/<pid>/io` 按 **bio**、syscall 计数按**调用**。三层数字必然逐级缩小：`syscr 10000/s → bio 3000/s → r/s 800` 是合并健康的表现，不是丢计数。对账时**跨层比较前先确认口径**，这是第 4 章 rchar/read_bytes 对账思路的块层延伸。

## 10.5 那 iostat 还怎么看

有效的读法收敛成四条：

1. `r/s+w/s` 与 `rkB/s+wkB/s` 的**趋势与配比**（突发来自读还是写、是否混跑）。
2. `r_await/w_await` **分列** + 与 IOPS 上升的**关联拐点**。
3. `dq`（diskstats 第 10 字段，部分 iostat 版本显示）与丢弃/错误列的**非零即报警**。
4. `%util` 只在 HDD/SATA SSD 单队列设备上作饱和指标。

> **关键认知**：iostat 是 1990 年代寻道时代的仪表盘，它的三个"平均"（%util 时间平均、await 延迟平均、aqu_sz 在途平均）在并行设备上**同时失去饱和含义**。SRE 的肌肉记忆应当是：NVMe 看 await 分列+直方图，云盘看配额与 burst 余额，HDD 才看 %util。

**本章要点：**

- %util 对 NVMe 失去饱和含义；只可靠用于单队列 HDD/SATA。
- await 均值掩盖双峰；读写混跑必须看 r_await/w_await 分列与尾延迟。
- aqu_sz 含排队、跨 hctx 摊平，深队列可能只是节流或 tag 等待。
- iostat 按 request、pid io 按 bio、syscall 按调用：三层对账先对口径。
- 新盘的仪表盘是直方图与配额读数，不是三个平均值。

---

# 第 11 章：SSD 与 NVMe 内部 - 快设备的三条慢线索

## 11.1 FTL 与写放大：4K 随机写的地狱

NAND 以**页**（4-16KB）读、以**块**（数百页）擦写；FTL（映射表）把逻辑页重定向到空闲物理页，垃圾回收把有效页搬家后整块擦除。于是：

- **写放大（WAF）= 物理写 / 逻辑写**，4K 随机写 + 高占用率时可达 10 以上——盘标 1GB/s 的带宽在 4K 随机写场景折到几百 MB/s 是常态。
- **占用率是隐形阀门**：盘快满时 GC 搬家成本暴涨，**同一块盘 90% 容量时的随机写延迟可能比 50% 时高一倍**——"越写越慢"不是错觉，是 GC 饥饿。
- **SLC 缓存骗局**：消费级盘把 TLC 当 SLC 用，前几十 GB 飞快、缓存打爆后断崖——**基准测试只写 10GB 就宣布性能结论，是排障大忌**（fio 要填满 SLC 缓存再测稳态，`--runtime` 拉长或 `--size` 超缓存容量）。

验证抓手：SMART 的 `wear_leveling`/`total_media_written` 与主机侧写入量之比即实测 WAF（字段名随厂商，`smartctl -a` 以盘为准）。

## 11.2 discard/TRIM：删除的语义不是擦除

POSIX unlink 只改元数据；**不 TRIM，FTL 不知道哪些物理页已死**，GC 会搬家"其实没用的数据"，WAF 虚高、可用空间虚低。启用梯度：

- 挂载 `discard`（每次 unlink 同步发，慢路径上多一跳——**不建议生产用**）vs 定期 `fstrim`（cron/systemd-timer，推荐）。
- 块设备层 `cat /sys/block/<dev>/queue/discard_granularity`（对齐粒度）、`/sys/.../features` 可见能力。
- mkfs 的 `discard` 选项初始化时 TRIM 全盘。

现场：`iostat` 看到周期性 `d2c`/大体积 discard 突发是 fstrim 在跑；`dbench/fio` 造"稳态"要先 trim 全盘再写满，否则测的是历史垃圾的 GC 成本。

## 11.3 namespace、PLP 与企业/消费的分水岭

- **NVMe namespace**：一个控制器可切多个 namespace（逻辑盘），各带独立队列与配额；云盘卷多映射为独立 namespace，**guest 看到的"块设备"与宿主物理盘之间隔了一层虚拟化**——排队可能发生在 hypervisor（第 7.4 已埋）。
- **掉电保护（PLP）**：企业盘用电容把写缓存+FTL 映射表安全落盘，**消费级盘掉电可能丢已 fsync 数据**（呼应 5.4 的合同校准）——选型时 `smartctl` 看 power_loss_protection 能力位。
- **队列模型**：NVMe 硬件队列对（SQ/CQ）由驱动按 CPU/中断建（`nvme_poll_queue` 一族），队列数、深度在 `nvme setup` 参数与 `/sys/class/nvme/*/queue_count` 可见——**NUMA 错配的 hctx 在 7.3 已述**，此处不再重复。

## 11.4 云盘：把盘的物理问题翻译成配额问题

云盘（virtio-blk/virtio-nvme/ebs 类）的真实形态：**IOPS/带宽/突发三层配额 + hypervisor 排队**。排障含义三条：

1. guest 里 `await` 的尾延迟来自宿主调度，**盘侧观测工具（blktrace）看不到配额等待的内部**，只能靠云厂商监控（BurstBalance、VolumeQueueLength）对齐。
2. 基线/突发型盘（burstable）**突发积分耗尽后断崖限速**——"跑了三天突然变慢"先查积分余额，不要查内核。
3. 配额以盘为单位，**同机多盘/多卷各自独立配额**——单卷打满不等于宿主机带宽打满，两个口径要分开监控。

> **关键认知**：SSD 时代"盘"不再是均匀介质：延迟分布、WAF、GC、配额把一块盘变成**随时间和使用率漂移的设备**。任何"盘标称 X 微秒"的推断，都要求稳态、空盘或已预热、已 TRIM 三个前提——**测试环境造不出这三个前提，结论就不可信。**

**本章要点：**

- NAND 页读块擦：WAF 由 GC 决定，容量占用率与随机写尺寸共同放大它。
- SLC 缓存只骗基准测试；稳态测试要写穿缓存，掉电安全看 PLP 能力。
- unlink 不擦除：生产用 fstrim 定期回收，不用挂载 discard。
- NVMe namespace 与云盘配额让"盘"变成虚拟化设备，guest 观测有盲区。
- 云盘突发积分耗尽是"越跑越慢"的外科手术刀式答案。

---

# 第 12 章：io_uring - 把系统调用摊平成共享环形缓冲

## 12.1 它要解决的账：syscall 密度

epoll 管"等"不管"做"：每次读写仍是 `read/write + 可能 sleep/wake` 一对陷入。4K 随机读百万 IOPS 时，**每秒百万次 syscall 的上下文切换与页表切换成本**（CPU 篇第 4/11 章的 switch_mm/KPTI 账在此会合）可与盘耗时同量级。io_uring（5.1 起，Axboe，`io_uring/`）的答案：**提交与完成都放在 mmap 共享环形缓冲里**，内核与用户态通过读写指针同步，**批量提交可以一次 syscall、完成可以零 syscall 轮询**。

## 12.2 SQE/CQE 环与三种执行姿态

```text
 用户: 写 SQE 到 SQ ring  --(io_submit 或 不提交)-->
 内核: 取 SQE -> 执行(快路径直接做/慢路径丢 worker)
      -> 写 CQE 到 CQ ring
 用户: 读 CQE (可 io_uring_enter 等, 也可轮询)
```

姿态矩阵（决定"CPU 账记在哪"的关键旋钮）：

| 配置 | 谁干活 | 适用 | 代价 |
|---|---|---|---|
| 默认 | 提交者线程内核态执行 | 普通负载 | 仍陷 syscall |
| sqpoll | 内核轮询线程直接取 SQE | 高吞吐免 syscall | 独占核（CPU 篇隔离账） |
| IOSQE_ASYNC | iou-worker 线程池执行 | 慢设备不堵提交 | worker 唤醒延迟 |

**sqpoll（`IORING_SETUP_SQPOLL`）的 CPU 税最隐蔽**：它起一个持续轮询的 kernel thread（`iou-sqp-*`），空闲也烧 CPU——**与 CPU 篇第 12 章 RT 带宽、隔离核那本账直接挂钩**：轮询线程会吃掉所在核的全部配额，独占部署要给它留一整个核。

## 12.3 fixed files 与 registered buffers：省的是查表与 pin

- `IOSQE_FIXED_FILE` + `register_files`：fd 到 file\* 的翻译查表预建，**每次 IO 省 fget/fput 与 fd 锁**（第 3 章 fd 表的延伸账）。
- `register_buffers`：iovec 指向的页预先 pin+GUP，省每请求的页查找与 **get_user_pages 开销**——小块高频场景收益显著。
- 两者都要求缓冲生命周期受控：**registered buffer 被 munmap 重用是经典 use-after 事故面**，内核加了 `IORING_REGISTER_BUFFERS_UPDATE` 等修补，仍以应用自律为先。

## 12.4 链、超时与取消

SQE 可 `link` 成依赖链（前一条完成才触发后一条，`IOSQE_IO_LINK`）、可挂 `timeout` 链接（超时取消后续）——**"读等写、超时可中断"从应用线程逻辑摊进内核完成事件**，省的是定时器+线程同步。6.x 还提供 `cancel` 操作。**注意 O_DIRECT + 注册的 buffer 对齐要求回到第 3 章三误解的对齐税**，io_uring 不改变 O_DIRECT 合同。

## 12.5 运维可见性：worker、IO 栈与容器边界

观测点：

```bash
# 每 ring 的 in-flight 与提交完成计数
grep -H . /proc/<pid>/io_uring
# worker 线程：iou-sqp-* 是轮询线程，iou-wrk-* 是 percpu 池
ps -eo pid,comm | grep iou-
# 事件：io_uring 组 tracepoint（5.10+）
cat /sys/kernel/debug/tracing/events/io_uring/enable
```

容器与安全边界（事故高发的制度面）：io_uring 历史上 CVE 密集（5.10 前的异步 O_DIRECT 权限、SQE 校验绕过），**多租户内核常整体禁用**（seccomp 挡 `io_uring_setup`）；5.15+/6.6 引入 `IORING_SETUP_SINGLE_ISSUER`、受限模式等收紧。排障含义：**应用报 "Operation not supported (errno 524/ENOTSUP)" 或 io_uring_setup EPERM，先查 seccomp/容器策略，不是内核太老。**

> **关键认知**：io_uring 把"IO 成本"从 syscall 摊成**环内存与 CPU 调度**两种可记账的形态——它的性能红利全部来自"谁轮询、谁执行、谁记账"三个配置选择。选型口诀：**慢盘+高并发用 IOSQE_ASYNC 保提交端不堵；极致 IOPS 用 sqpoll+fixed，但为轮询线程划独占核；容器化多租户先确认 io_uring 未被策略禁用。**

**本章要点：**

- io_uring 用共享 SQ/CQ 环摊平 syscall：批量提交、可零 syscall 完成。
- 三种姿态（默认/sqpoll/ASYNC）决定 CPU 账记在提交者、轮询线程还是 worker 池。
- sqpoll 空闲也烧 CPU，要配独占核；IOSQE_ASYNC 用 worker 换提交端不堵。
- fixed files/buffers 省 fget 与 GUP，但缓冲生命周期责任转移到应用。
- 容器里 io_uring_setup EPERM 多为 seccomp 策略；524/ENOTSUP 别找驱动。

---

# 第 13 章：叠加文件系统与网络文件系统 - 块设备之外的两种"远端"

## 13.1 overlayfs：容器的可写层是一场数据搬家

容器镜像的根文件系统是 overlayfs：多个只读 `lowerdir` 叠一个可写 `upperdir`，元数据视图统一（VFS 层合成，呼应第 2 章 dentry/inode 的"翻译官"角色）。关键机制是 **copy-up**：

- **触发时机**：对下层文件第一次以写方式 `open`（不是 `write` 才触发——打开即搬），以及 chmod/chown/rename 等元数据变更。
- **动作**：把整个文件从 lower 复制到 upper、建白障（whiteout）遮盖原文件，此后读写都落在 upper——**"打开一个 1GB 只读日志准备追加"= 一次同步的 1GB 拷贝**，现场是 open 系统调用耗时暴涨而 iostat 显示下层设备在读、上层在写。
- **页缓存陷阱**：copy-up 后新文件与旧文件的 page cache 是两套；已 mmap 旧 inode 的读者看到的仍是旧数据。
- **元数据 copy-up**：目录只建一个"upcast"目录项、不复制内容；**海量小文件的 chmod -R 会 copy-up 全部文件**——镜像构建末段的 `chmod -R` 是镜像膨胀的经典来源。

可观测：`/proc/<pid>/mountinfo` 里 overlay 行的设备号是 upperdir 所在设备（2.5 的 stat 设备号在此汇合）；ftrace `ext4`/`overlay` 事件或 `strace -e openat` 看到"open 慢在文件系统层"即可定罪 copy-up。**处方**：大文件追加场景改用 emptyDir/volume 直挂，避免在叠加层做大文件 O_WRONLY。

## 13.2 NFS：D 态的制造机与 sunrpc 状态机

NFS 客户端把 POSIX 调用翻译成 RPC（sunrpc 层，`fs/nfs/`、`net/sunrpc/`），**"远端"从块设备换成了网络**，排障账本随之换三行：

1. **延迟 = 网络 RTT + 服务端处理**，客户端的 iostat 几乎什么都看不到（没有本地 request）——观测要换 `/proc/self/mountstats`（每 RPC 过程的 rtt、execute 分解）与网络工具。
2. **hard mount 的重试语义制造 D 态**：服务端无响应时，任务卡在 `nfs_wait_on_request`/rpc 队列，**状态是 D（不可中断）而非 io 等待**——CPU 篇第 6 章的 D 态判读在此要用"网络 IO"变体：`wchan` 显示 rpc 相关函数、`/proc/<pid>/stack` 出现 `nfs_*`/`rpc_*`。soft mount 可超时返回错误，但**语义破损**（应用可能拿到 EIO 而以为成功写入），数据库场景禁用 soft。
3. **commit 语义**：NFSv3 的 `COMMIT`、v4 的写回确认——NFS 上 fsync 的成本≈把写缓存刷到**服务端**并等确认，链路抖动直接打在 fsync P99 上。

现场处置梯度：先 `mountstats` 分 RTT/server 两段；`nfs_statis`/`sunrpc` 计数确认重传（`retrans`）；服务端 hang 则恢复后**白障式堆积的 D 态会一次性苏醒**——大量进程同时 runnable，CPU 篇第 9 章的 run 队列突增在此有了 IO 解释。

## 13.3 device-mapper 与多路径：你看的设备可能不是盘

LVM/加密/多路径/云盘 agent 都插在 FS 与真实盘之间（`drivers/md/dm-*.c`）：`/dev/mapper/vg-lv` 背后可能是两个 SCSI 路径、或 `crypt` 再叠 `raid`。**blktrace 与 iostat 的对象要选对层**——对 dm 设备看到的延迟含下层全部路径，对底层盘看到的是物理真实；两层差值就是 dm 自身与路径故障切换的成本。现场：

- `dmsetup stats`、`/sys/dm-*/` 与 multipathd 日志对路径 fail（`PDH`/`pgfailback`）时间戳。
- **多路径抖动表现为"周期性 await 尖刺"**（failover 重试超时约数秒），与盘/网络无关——别在盘侧查。
- io_uring/O_DIRECT 在 dm-crypt 上会走 iou-worker（块层异步不支持加密路径），第 12 章"慢设备不堵提交"在此自动生效，性能模型变 CPU+轮询。

> **关键认知**：叠加与网络文件系统把"IO 栈"变成"两种栈"——overlayfs 的贵是**一次性搬家**（copy-up 全量），NFS 的贵是**每次往返**（RPC 语义）。前者的证据在文件系统事件与 open 耗时，后者的证据在 mountstats 与重传计数；**用本地盘的仪表盘（iostat）看这两种栈，结论必然是"设备不忙、应用却慢"**。

**本章要点：**

- overlayfs 以写打开触发 copy-up 整文件搬家；chmod -R 与 mmap 旧 inode 是两个经典暗坑。
- NFS 的 D 态是 rpc 等待，观测靠 mountstats/retrans；soft mount 语义破损。
- NFS 上 fsync 成本含网络 RTT 与服务端确认，链路抖动直接进 P99。
- dm/多路径下 iostat 要分层读数；周期性尖刺先查路径 failover。
- 块设备仪表盘对叠加/网络栈失明：先认栈型，再选证据源。

---

# 第 14 章：内存与 IO 的耦合 - 回收、swap 与 PSI io 的真相

## 14.1 为什么"盘慢"经常是"内存紧"

内存篇的回收入队后，IO 篇的三处耦合浮出水面：

1. **回收驱动回写**：脏页直接回收（`shrink_node -> writeback`）让 kswapd/direct reclaim **主动提交 bio**——内存压力尖峰在 iostat 上表现为 wr/s 突增，**源头不是应用写**。
2. **swap IO**：换出/换入是页粒度的块 IO（第 8-9 章 page cache 换入的镜像逻辑），zram/zswap 可把这段变成 CPU 压缩账——**swap 设备上的 await 直接打在缺页路径上**，与 mmap 缺页（第 4 章）同型：延迟藏在 CPU 停顿里。
3. **GFP 约束链**：`GFP_IO`/`GFP_FS` 标记控制"本次分配可否进 IO/文件系统代码"——回收路径若进 FS 回写又触发 FS 分配内存，递归死锁。内核用 `__GFP_NOFS`（如 jbd2、writeback 元数据路径）斩断；**应用侧 `mmap` 的锁页（`MAP_POPULATE`/`mlock`）则反向斩断回收**——内存篇与 IO 篇在此握手。

## 14.2 三种"卡在 IO"的形态学

| 形态 | 任务状态 | 证据 | 根因层 |
|---|---|---|---|
| direct reclaim 等回写 | D | stack 含 `congestion_wait`/`wait_on_page_writeback` | 内存水位 |
| swap-in 缺页 | 不可中断短暂睡 | pgmajfault 涨 + swap io 涨 | 内存水位+盘 |
| fsync/flush 等盘 | D/S(节流) | `ext4_sync_file`/`balance_dirty_pages` | 第 5 章闸门 |

分诊要点：**第一种要降内存压力（扩容/限 memcg），第二种要分 CPU 篇（majflt 在指令里）与 IO 篇（swap 盘 await）两头看，第三种才轮到盘侧优化**——"IO 等待高先查内存"不是玄学，是比例学：生产环境 D 态尖峰里 direct reclaim 占比往往最高（内存篇 15 章 memcg 的回收账在此兑现）。

## 14.3 PSI io：full 与 some 的精确含义

`/proc/pressure/io`（需内核开 `CONFIG_PSI`，部分发行版要 `psi=1` 挂载参数）：

```text
some avg10=2.31 avg60=1.85 avg300=1.20 total=471122
full avg10=0.42 avg60=0.31 avg300=0.22 total=99001
```

- **some**：至少一个任务因 IO 停滞而不可运行的时间占比——"有人在等盘"。
- **full**：**所有 CPU 上的可运行任务都因 IO 停滞**的时间占比——"整台机器为盘停工"。

与 CPU 篇 15 章同构且更苛刻：IO full 要求"每个 runnable 任务都堵在 IO"，只要有一个任务在烧 CPU，full 就记 0。**因此 io some 是日常主力，io full 是"机器级 IO 瘫痪"警报**——数据库机器 io full 持续 >1 基本等价"业务全停"。两条已立账的细节在此合拢：

1. **cgroup 的 io.pressure 按本组任务算 full**——容器内"全组停工"时全局不动（9.4 埋的伏笔）；K8s 驱逐/告警应看组级。
2. **节流等待计入 io pressure**：`balance_dirty_pages` 的睡眠属于"memory stall"还是"io stall"？PSI 分类里它算 **memory**（`PSI_MEMORY`，因为根因是脏页水位）——**fsync 等待算 io，脏页节流算 memory**，这一条能解释"PSI memory 高但回收不活跃"的怪案。

## 14.4 案例骨架：memcg 限额引发的"IO 变慢"

现象：给应用容器加内存 limit 后，业务 P99 读延迟翻倍，盘监控一切正常。

- 证据链：容器 `memory.pressure` 的 memory some 高 → `memory.stat` 中 `total_pgpgout` 增速异常（回收回写）→ 全局 `/proc/pressure/io` some 微涨但**设备 await 不涨** → 结论：**应用线程在 direct reclaim 里替内核回写自己的页**（形态学第一种），盘的 await 低是因为 bio 在应用线程手里排队，不是设备慢。
- 处置：抬 limit / 用 `memory.high` 软 throttle 换突刺为持续限速 / 给该容器换更快的回写设备。
- 呼应 CPU 篇 15 章：memcg 的 memory PSI 与这里的 io PSI 是同一笔账的两面——**先有 memory stall，后有 io stall**。

> **关键认知**：PSI 的三本账（cpu/memory/io）之间**有因果箭头**：memory 节流表现为 io some 的时间，io full 的根因可能是 memory——读 PSI 不是读三个数，是读一个三角。排障口径：**设备指标正常 + 应用 IO 等待高 = 内存侧回写；设备指标异常 + cgroup 正常 = 真盘问题；两者都高 = 先治内存（它通常先赢）。**

**本章要点：**

- 回收主动回写、swap 缺页、GFP_NOFS 斩递归：内存压力总会转成 IO 现象。
- 卡 IO 三形态分诊：reclaim 等回写、swap-in 缺页、fsync 等盘，用药各不同。
- io some=有人在等盘，io full=全机为盘停工；组级 full 与全局可以背离。
- 脏页节流计入 PSI memory 而非 io；读 PSI 要读三角不读单数。
- memcg 加限额后"盘没变慢应用变慢"：多半是应用线程在替内核回写。

---

# 第 15 章：IO 观测工具箱与案例集 - 把五闸与三本账接上电

## 15.1 blktrace：块层的七色事件流

`blktrace`（`kernel/trace/blktrace.c`）在块层关键站点埋事件：**Q**（queue，进队）→ **G**（get request，拿到 tag）→ **I**（insert，入调度器）→ **D**（dispatch，下发硬件）→ **C**（complete）→ **R**（requeue）→ **S/P**（sleep/重入）。`btrace` 直接读成人话，`blkparse` 出明细。用法与读法：

```bash
# 抓 20 秒全量（产物在 /dev/shm 防自反噬）
blktrace -d /dev/nvme0n1 -o - | blkparse -i - > /dev/shm/trace.txt
# 看 Q->D 间隔大 = 调度器或 tag 等待；D->C 大 = 设备慢
```

**Q→G 间隔**是 9.1 第 2 闸的显影（tag 等待），**I→D** 是第 3 闸（调度器排队），**D→C** 才是设备真实服务时间——**iostat 一个 await 拆成三段的责任归属，blktrace 是唯一原生工具**（bpftrace 也能拼，见 15.2）。

## 15.2 bpftrace：延迟直方图与 biosnoop

现成脚本：bcc 的 `biosnoop`（每 bio 一行：设备/扇区/延迟/pid）与 `biolatency`（直方图）是值班首选。手写 bpftrace 版（全程不用美元符号变量，只用 @ 映射）：

```text
kprobe:blk_account_io_start { @s[args] = nsecs; }
kretprobe:blk_mq_end_request /@s[arg0]/ {
  @us = hist((nsecs - @s[arg0]) / 1000);
  delete(@s[arg0]);
}
```

（5.15+ 函数名有改：`blk_account_io_start` 拆为 `blk_mq_start_request`，以本机 `available_filter_functions` 为准；直方图桶为微秒对数刻度。）读法铁律：**双峰=两类请求混跑（读+写、或 4K+128K），长尾=第 10 章 await 均值骗局的原形；直方图先于一切优化。**

## 15.3 案例集：五闸与三本账的实战连线

**案 1：容器首次写大文件巨慢，之后正常。** open 耗时 2s+，iostat 下层设备读+上层设备写 → overlayfs copy-up（13.1）。处方：大文件走卷挂载。

**案 2：fsync 每秒规律尖刺。** await 直方图双峰、尖刺时刻 jbd2 线程 D → 5s 提交周期 + checkpoint 反压（6.2/6.3）。处方：日志设备分离或加大 journal。

**案 3：盘用两年随机写劣化 5 倍。** 容量占用 85%、SMART media_written 对主机写入比值 WAF≈8 → GC 饥饿 + 稳态未测（11.1）。处方：扩容降占用、预留 OP、稳态测试。

**案 4：写慢但设备不忙、任务无 D 态。** PSI memory some 高、Dirty 长期顶水位、任务栈在 `balance_dirty_pages`（S 态）→ 脏页节流（5.2/14.3）。处方：降写入突发或调水位并扩回写带宽——先确认设备真的还有余量（第 9 章五闸同表）。

**案 5：批量任务同时 D 后集体苏醒、run 队列暴增。** wchan 含 `nfs_*`、`mountstats` retrans 暴涨 → NFS 服务端 hang（hard mount）+ 恢复风暴（13.2/CPU 篇第 9 章）。处方：服务端治本 + 关键链路评估 soft-retry 语义或超时降级。

## 15.4 全书地图：IO 三本账与三部曲接口

IO 篇的四根弦（第 1 章）落成三本账：

```text
 带宽账   rkB/s wkB/s 预读 回写批量     (第 4/5 章)
 IOPS账   r/s w/s tag 队列深度 调度器   (第 7/8/9 章)
 延迟账   await三段 Q->G I->D D->C 直方图(第 10/15 章)
 一致性弦 贯穿：fsync/journal/PLP/目录   (第 5/6/11 章)
```

与 CPU 篇、内存篇的三条接口线：**回收→回写**（14 章⇄内存篇 10-12 章）、**PSI 三角**（14 章⇄CPU 篇 15 章）、**缺页与 mmap**（4 章⇄CPU 篇 11 章）。值班长的分诊总流程沿用 CPU 篇 14 章五步法的 IO 变体：**立案（哪类业务慢）→ 定性（节流/排队/设备/网络/内存五闸定位）→ 分段（await 拆 Q-G-I-D-C）→ 定罪（tracepoint/直方图点名）→ 处置（限并发/换策略/扩容量/治内存）**。

> **关键认知**：IO 排障的终局判断只有一句——**"慢"发生在五道闸的哪一道，"账"记在三本里的哪一本**。iostat 给你一本平均账，blktrace 给你分段责任，PSI 给你停工比例，SMART/云监控给你设备真相；任何单一工具都不构成结论，**结论来自口径对齐后的互相印证**。

**本章要点：**

- blktrace 的 Q/G/I/D/C 把 await 拆成 tag、调度器、设备三段责任。
- biolatency/直方图先于优化：双峰=混跑，长尾=均值骗局的原形。
- 五案例覆盖 copy-up、jbd2、GC、节流、NFS hang——都是跨层连线题。
- IO 三本账（带宽/IOPS/延迟）+ 一致性弦是全书收束框架。
- 三部曲接口：回收-回写、PSI 三角、缺页-mmap——单篇病历要跨篇复核。

---
