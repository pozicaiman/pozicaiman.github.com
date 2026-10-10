---
title: Linux 内核 CPU 设计与管理体系：从调度决策到带宽控制与观测
date: 2026-10-09 14:00:00
categories: [操作系统]
tags: [Linux, 内核, CPU, 调度器, 性能优化, SRE]
---

> 姊妹篇《Linux 内核内存设计与管理体系》讲的是**物理页**的一生。本篇讲的是**算力**的一生：一个任务如何被赋权、如何排队、何时上 CPU、被谁抢占、上下文切换时发生了什么、限额与隔离如何改变这一切，以及"CPU 忙"与"CPU 饱和"为什么是两回事。
>
> 口径说明：全文以 Linux 5.10 / 5.15 / 6.6 LTS 为基准，涉及版本差异处逐条标注（本篇横跨一个关键分水岭——**6.6 用 EEVDF 替换了 CFS 的算法层**）；所有机制描述以内核源码路径为准，不确定处明确写"以本机源码为准"，不做经验性断言。

---

# 第 1 章：引言 - 内核 CPU 管理要回答的三个问题

## 1.1 三份账，一条链

内核内存管理回答"放得下吗/找得到吗/还得掉吗"，CPU 管理同样有三份账：

1. **该谁跑**——决策侧。多个任务竞争一个 CPU 时，按什么规则选？选出来跑多久？来新人（唤醒）要不要换？
2. **跑得动吗**——供给侧。CPU 本身的状态由谁决定：频率（cpufreq）、深度休眠（C-state）、被中断占用、被虚拟化偷走（steal）。
3. **管得住吗**——控制侧。怎么在成千上万个任务里圈出一组来隔离（cpuset/isolation）、限流（cpu.max）、保实时（RT/Deadline）。

日常运维里的"CPU 问题"都能对号入座：

```text
该谁跑     → 调度延迟、抢占不及时、负载不均、线程池抖动
跑得动吗   → 频率没上去、C-state 退出慢、中断风暴、steal
管得住吗   → 容器 throttling、绑核后长尾、隔离配置失效
```

> **关键认知**：CPU 忙 ≠ CPU 计算饱和。`top` 里 100% 的 `%CPU` 只说明"这个 CPU 上没有空闲"，不说明"算力被有效使用"——它可能卡在自旋锁上、可能在等页表切换、可能被 throttled 后处于 runnable-but-not-running 状态、也可能频率只有标称值的一半。排障的第一步永远是先问：**忙的是谁，供给是多少，等的人有多少**。

## 1.2 全景：一个任务的一生

先把本篇 16 章压进一张图。一个可运行任务从诞生到反复上下 CPU，走的是这样一条链：

```text
                fork / clone / exec
                      │
                      ▼
        ┌───────────────────────────┐
        │  该谁跑？决策侧           │
        │  类 → entity → rq         │
        └───────────────────────────┘
                      │
                      │ 选中，__schedule 换上来
                      ▼
        ┌───────────────────────────┐
        │  跑得动吗？供给侧         │
        │  频率/中断/steal/切换     │
        └───────────────────────────┘
                      │
                      │ 限额、隔离、实时保活
                      ▼
        ┌───────────────────────────┐
        │  管得住吗？控制侧         │
        │  quota/cpuset/RT/DL       │
        └───────────────────────────┘
```

三侧各自的观测入口，就是后续章节的地图：决策侧看 `/proc/schedstat` 和 `perf sched`；供给侧看 `mpstat`、`cpufreq` sysfs、`/proc/interrupts`；控制侧看 cgroup v2 的 `cpu.stat` 与 `cpu.max`。

## 1.3 调度器类：位图选类的静态优先级

Linux 不是"一个调度器"，而是**一组按静态优先级串起来的调度类**。每个 runqueue 上，`pick_next_task` 从高到低扫一遍优先级位图，第一个有任务的类胜出：

```text
优先级（kernel/sched/sched.h，枚举名以本机源码为准）
  stop          最高，迁移线程等内核自带任务，用户不可用
  deadline      SCHED_DEADLINE，准入控制，见第 12 章
  realtime      SCHED_FIFO / SCHED_RR，跑不完就一直占着
  fair          SCHED_OTHER，CFS(≤6.5) / EEVDF(6.6+)，绝大多数进程
  idle          每个 CPU 的 swapper 空闲任务，兜底
```

```c
/* kernel/sched/core.c 概念示意 */
for_each_class(class) {
    p = class->pick_next_task(rq);
    if (p)
        return p;
}
```

这个设计带来两条铁律：

1. **RT 任务可以饿死所有人**。一个 100% 占 CPU 的 `SCHED_FIFO` 任务，会让 fair 类的所有进程（包括 `sshd`）拿不到 CPU——除非内核做了 RT 全局限流（第 12 章的 `sched_rt_runtime_us`）。
2. **fair 类内没有绝对优先级**。nice -20 和 nice 19 之间是**权重比**，不是"插队权"——只要 fair 类整体能从 RT/DL 手里分到 CPU，两个 nice 值的任务都能跑，只是份额不同。这个区别在第 3 章用数字算给你看。

## 1.4 核心数据结构：task_struct → sched_entity → rq

调度世界里的三个主角（简化到骨架）：

```c
/* kernel/sched.c 概念示意 */
struct task_struct {
    int                 prio;        /* 静态+动态合成的调度优先级 */
    unsigned int        policy;      /* SCHED_OTHER/FIFO/RR/DEADLINE */
    const struct sched_class *sched_class;
    struct sched_entity se;          /* fair 类的实体 */
    struct sched_rt_entity rt.se;
    struct sched_dl_entity dl;
    cpumask_t           cpus_allowed; /* 亲和性掩码 */
};

struct sched_entity {                  /* include/linux/sched.h */
    struct load_weight  load;          /* 权重 = nice 映射而来 */
    u64                 vruntime;      /* CFS：已消费的虚拟时间 */
    u64                 min_vruntime;  /* 本队列的虚拟时间基准线 */
    struct rb_node      rb_node;       /* 就绪任务挂在这棵红黑树上 */
    u64                 exec_start;    /* 上次上 CPU 的时刻 */
    u64                 sum_exec_runtime; /* 累计真实运行时间 */
    struct cfs_rq       *cfs_rq;       /* 所在队列（可能是组的） */
};

struct rq {                            /* kernel/sched/sched.h */
    u64                 clock;         /* 调度时钟（本地或全局） */
    struct mm_struct    *curr;         /* 当前任务 */
    struct task_struct  *idle;         /* swapper 任务 */
    struct cfs_rq       cfs;           /* 根队列 */
    unsigned long       nr_running;    /* 本 rq 就绪任务数 */
    atomic_t nr_switches; ...          /* 切换计数 */
};
```

三个要点：

1. **rq 是 per-CPU 的**。每个 CPU 有自己的运行队列、自己的红黑树、自己的 `clock`。任务从一个 rq 迁到另一个 rq，`vruntime` 要在两个 `min_vruntime` 之间做折算（第 3 章）。
2. **sched_entity 有两条世界线**。普通进程只有一个 `se`；cgroup 组调度时，组本身也是一个 `se`，挂在父 `cfs_rq` 的红黑树上，叶子进程组成子 `cfs_rq`（第 6 章的层级结构）。
3. **红黑树按 key 排序**。CFS 的 key 是 `vruntime`，EEVDF 的 key 是 `deadline`（第 4 章）——这是两代算法唯一的结构性差异，其余全在选点逻辑里。

## 1.5 观测锚点：先学会看三张表

后面每一章都会回到这三张表，先建立基线：

```bash
# 全局 CPU 时间账（按核展开，字段含义见第 2 章）
vmstat 1 5
mpstat -P ALL 1 5

# 每核调度统计：runqueue 时长、等待时长、切换次数
cat /proc/schedstat        # 每 rq 一行，第 5 字段开始是 wait 累计

# 事件级：谁在何时换下谁
perf sched record -- sleep 5
perf sched latency         # 按任务汇总 wakeup→start 的最大/平均延迟
```

> **关键认知**：`perf sched latency` 的列名是内核给的免费分诊表——` Average  Maximum  migrations  switches` 四个数各自指向完全不同的病因：延迟高但切换少 → 抢占或队列问题；延迟不高但 migrations 多 → 亲和性或负载均衡问题。先分诊再深挖，别一上来就翻 `/proc` 大海捞针。

**本章要点：**

- CPU 管理的三份账：决策侧（该谁跑）、供给侧（跑得动吗）、控制侧（管得住吗）；排障先对号入座。
- CPU 忙 ≠ 计算饱和：100% 占用率可能是自旋、等待、限流或降频，必须拆分归因。
- 调度器类按位图静态选类：stop > deadline > rt > fair > idle；RT 可饿死 fair，fair 内部只有权重没有插队。
- 核心三角：`task_struct` 带 `sched_entity`，`se` 挂红黑树，红黑树长在 per-CPU 的 `rq` 上；组调度时组也是 `se`。
- 三张观测底表：`/proc/schedstat` 看队列时长，`perf sched latency` 看延迟与迁移，`mpstat -P ALL` 看每核供给。

---

# 第 2 章：供给的多副面孔 - 利用率口径与 loadavg

## 2.1 /proc/stat：八个桶，一个分母

内核给每个 CPU 记一笔时间流水账（`fs/proc/stat.c`，数据来自 `kernel/sched/cputime.c`）：

```text
/proc/stat 的 cpu 行分桶顺序：
  user      用户态（含 guest，不重复计）
  nice      低优先级用户态（含 guest_nice）
  system    内核态
  idle      空闲
  iowait    空闲且有未完成块 IO（idle 的子集）
  irq       硬中断
  softirq   软中断
  steal     被 hypervisor 拿走的时间
```

分桶规则决定了很多"常识"其实不成立：

1. **guest 不是独立桶**。`guest` 计入 `user`，`guest_nice` 计入 `nice`——虚拟机里看 host 视角的 CPU，别把这些时间重复计算。
2. **iowait 的定义**。`iowait = idle 时间且此刻有未完成的块层 IO`（`get_cpu_iowait_time_us`）。它是**空闲的一个子集**，不是忙碌桶——`%iowait` 高恰恰说明 CPU 空着，至于慢不慢在存储侧，要另案分析（IO 篇第 1 章）。
3. **steal 是 hypervisor 的账**。时间片被宿主机拿走给了别的 VM，guest 内核只能事后从 paravirt 接口补记。云主机上 `mpstat` 的 `%steal` 持续非零，问题根本不在 guest。

## 2.2 时间记账的两条实现路径

任务在 CPU 上跑，时间记到它的 `utime/stime`（`/proc/[pid]/stat` 第 14/15 字段）；空闲和 irq 记 per-cpu 不记任务。记账实现有两种：

```text
tick 记账     每个调度 tick（通常 250/300Hz）结算一次
              精度 = 1/tick，误差 ±0.5 tick，开销与 HZ 挂钩
IRQ-based     每次进出用户态采集 clock（CONFIG_VIRT_CPU_ACCOUNTING_GEN）
              精度纳秒级，开销在边界上，arm64/部分 x86 配置常用
```

**后果**：短任务（微秒级）在 tick 记账下 `utime` 可能显示为 0——不是没跑，是没跨过一个 tick。用 `pidstat -t 1` 看线程级 CPU 时，短生命周期线程"看不见"就是这个原因，要看 `/proc/[tid]/sched` 里的 `se.sum_exec_runtime`（真实累计运行时长，纳秒）。

## 2.3 loadavg：一个被误读最多的数字

`/proc/loadavg` 的三个数由 `calc_global_load`（`kernel/sched/loadavg.c`）维护，公式在 `scheduler.h`：

```c
/* 每 5 秒一个采样，指数衰减，周期常数固定 */
VOID    /* 半衰期约 5s/10s/15s 三组系数，以本机源码为准 */
load = load * old_weight + active * (1 - old_weight);
```

关键在于 `active` 数的是什么：

```c
/* kernel/sched/stats.h 概念示意 */
 nr_running(rq) + nr_uninterruptible()
```

**它是" runnable + 不可中断睡眠(D) "的任务总数，不是 CPU 使用率**。三种误读由此产生：

```text
load 高，CPU idle 也高   →  D 状态堆积：等存储/等网络/等页回收
load 与核数持平但延迟高   →  真的饱和：每个核上都有排队的任务
load 低但业务抖动         →  loadavg 是 1/5/15 分钟平滑，
                            秒级毛刺根本进不了它的账
```

> **关键认知**：`vmstat 1` 的 `r` 列是 **1 秒采样的瞬时 runqueue 长度**，比 loadavg 灵敏得多；`ps`/`btop` 显示的 load 只是同一内核数据的展示。判断"饱和"要用 `r` 对 `nproc`，判断"趋势"才用 loadavg——两者的时间分辨率差一个量级。

## 2.4 top 的三个视图：Cpu(s)、KiB Mem、Tasks

`top` 默认行的字段来源逐个对上：

```text
%Cpu(s): 30.0 us ... 10.0 id 10.0 wa  ←→ /proc/stat 各桶占比
MiB Mem / Swap                         ←→ /proc/meminfo（内存篇）
Tasks:  total, running, sleeping,
        stopped, zombie                ←→ /proc/[pid]/stat state 聚合
load average: 8.0, 6.0, 4.0            ←→ /proc/loadavg
```

`Threads` 行里的 `running` 才是和 runqueue 直接对应的数；`sleeping` 里混着 S（可中断）和 D（不可中断）——`top` 的 `State` 列里 **`D` 单列**，看到一排 D，先查他们等的是 IO 还是锁（`cat /proc/[pid]/wchan`、`/proc/[pid]/stack` 需要开启 `CONFIG_STACKTRACE`）。

## 2.5 饱和 vs 忙碌：分诊树

把 2.1-2.4 的数据拼成一条判断链：

```text
业务慢
  ├─ r 长期 > 核数？ ──是──→ 计算饱和或 throttled 后排队
  │                          （cpu.stat nr_throttled 佐证，第 6 章）
  ├─ us 高但 r 不超核数？ 
  │     ├─ 单线程烧穿一核 → 热点线程，perf top 找函数
  │     └─ 自旋/锁竞争    → perf 里 native_queued_spin_lock_slowpath
  │                        可见（第 14/15 章）
  ├─ sy 高？            → 中断/软irq/系统调用风暴，
  │                        看 /proc/softirqs 增量（第 12 章）
  ├─ st 高？            → 云资源争抢，联系宿主侧
  ├─ wa 高 + %util 高？  → 块设备队列深，IO 篇分诊
  └─ 全都正常？          → off-CPU：任务在等，不在跑
                           （第 13 章：调度延迟与 off-CPU 分析）
```

**本章要点：**

- `/proc/stat` 的 user/nice/system/idle/iowait/irq/softirq/steal 各有严格记账规则：guest 含于 user，iowait 是 idle 的子集，steal 是宿主的账。
- 短任务的 CPU 时间在 tick 记账下可能是 0，精确账看 `se.sum_exec_runtime`。
- loadavg = `nr_running + nr_uninterruptible` 的指数衰减平均，D 状态堆积会伪装成 CPU 压力。
- 判断饱和用 `vmstat` 的 `r` 对 `nproc`，判断趋势才用 loadavg；两者时间分辨率差一个数量级。
- 排障分诊树第一步是拆分"忙"的构成：r 超核数、us/sy/wa/st 各桶、还是 off-CPU 等待。

---

# 第 3 章：虚拟时间 - CFS 的权重、vruntime 与粒度

## 3.1 算法问题：怎么在流式到达的任务间"公平"

批处理时代可以算"谁等得最久"，交互系统不行——任务随叫随到，等待时间无法作为唯一标尺。CFS（Constant Elastic Scheduling，`kernel/sched/fair.c`，作者 Ingo Molnar 的注释自述是"简单、精确、启发式最少"）的解法：**不问谁等得久，只问谁跑得少**。

给每个任务记一笔虚拟时间 `vruntime`，永远选 `vruntime` 最小的跑。跑得多的任务虚拟时间涨得快，就自然被跑得少的追上来——**公平被定义为"每笔账最终相等"**，而不是"每轮轮流一次"。

## 3.2 权重：nice 值换算成 1024 分制

`vruntime` 的增速由权重控制。nice 到权重的映射在 `include/linux/sched/scales.h`：

```c
/* 权重表节选（1024 分制，以本机源码为准） */
nice:      -5     0     5    10     19
weight:   3121  1024   420    155      15
```

换算规则是每级 nice 差 1.25 倍：

```c
/* kernel/sched/fair.c 概念示意 */
vruntime 增速 = 真实时间 × (NICE_0_LOAD / se->load.weight)
/* ns2ticks 思路：weight 越大，同样真实时间折算的虚拟时间越少 */
```

数字账（0.8 = 1/1.25）：

```text
nice -5 vs 0   →  3121:1024 ≈ 3.05 倍份额
nice 0  vs 5   →  1024:420  ≈ 2.44 倍份额
nice 0  vs 19  →  1024:15   ≈ 68 倍份额（不是 19 倍！）
```

**两个推论**：nice 19 在 CPU 饥饿时几乎分不到时间（15/1024）；而 nice 每降 1 级，份额 ×1.25——**这是比例公平，不是绝对优先**，1024 分制让任意数量的任务都能在同一把尺子上加权。

组调度的层级权重继承（组权重按比例分父份额）在第 6 章。

## 3.3 min_vruntime：每棵树的基准线

红黑树按 `vruntime` 排序，但 `vruntime` 是单调递增的无界值——新任务、睡眠醒来的任务该记多少？CFS 的做法是给每个 `cfs_rq` 记一条 `min_vruntime`（队列中最小任务的虚拟时间近似值），所有入队任务的 `vruntime` 都**相对这条基准线放置**：

```text
新建/唤醒任务：  vruntime = min_vruntime - granularity（略提前，
                 让它先跑一阵子，但不许白捡大便宜）
睡眠补偿：      睡掉的真实时间不倒扣虚拟时间（否则睡 = 赚），
                 醒来以 min_vruntime 附近入队
迁移折算：      从 rq_a 迁到 rq_b 时，先减 a 的 min_vruntime
                 再加 b 的 min_vruntime（task_proportional_...）
```

> **关键认知**：睡眠不攒"积分"是 CFS 的关键反直觉设计。如果睡醒能白捡虚拟时间，长睡眠任务会瞬间霸占 CPU 直到把"攒的便宜"花完——系统会退化成"惩罚一直在跑的人"。EEVDF 后来用 lag 机制把欠账/盈余显式记账（第 4 章），算是给这个妥协打了个补丁。

## 3.4 粒度：调度周期与最小时间片

纯按最小 `vruntime` 选任务会导致**每纳秒切换一次**（两人份额接近时永远互相反超）。CFS 引入两个旋钮限制抖动（`kernel/sched/debug.c` 可调项，5.x 后部分改由 `sched_fair` 自适应，以本机源码为准）：

```text
sched_latency_ns      目标：一轮把所有就绪任务跑完的周期
                      默认随核数自适应（核越多周期越长）
sched_min_granularity_ns  目标：每个任务至少分到的一片
                      任务数超阈值后 latency 不再拉长，切片被摊薄
wakeup_granularity_ns 唤醒抢占门槛：新人要领先老人这么多
                      虚拟时间才允许踢人
```

数字账：100ms 周期、4ms 最小片 → 最多同时 25 个就绪任务不被摊薄；1000 个就绪任务 → 每任务名义上只分到 0.1ms，切换开销占比飙升——**CFS 的公平性在超高并发下自动让位于吞吐**，这就是 `nr_running` 极高时上下文切换暴涨的机制根源（配合第 4 章的 `nr_context_switches` 验证）。

## 3.5 唤醒抢占与 buddy：交互性的启发式补丁

算法层只保证"长期公平"，交互体验靠三个启发式：

```text
wakeup_preempt    新人 vruntime 领先老人 ≥ wakeup_granularity
                  → 老人被抢占（交互任务醒来秒响应）
NEXT_BUDDY        刚被唤醒/刚跑过的任务标记为"下任优先"
                  → pick_next 时允许它反超最小 vruntime 的树根
                 （5.x 后期此机制逐渐被简化，以本机源码为准）
LAST_RRUNNING     树根刚被换下时，第二小的任务获得连任宽容
```

这组补丁的代价是**公平性有泄漏**：频繁短暂唤醒的交互式任务（每次醒来都蹭 NEXT_BUDDY）拿到的实际份额会超过账面权重——`pidstat` 里"权重相同但 CPU 不均"的怪象多半源于此。EEVDF 的 lag 记账（第 4 章）正是为了把这类"欠账"量化。

## 3.6 观测：把 vruntime 从树上揪出来

```bash
# 单任务账本：虚拟时间、真实时间、等待时间、迁移
cat /proc/[pid]/sched        # se.vruntime / se.sum_exec_runtime
                             # se.statistics.wait_sum / nw_migrations

# 队列账本：每 rq 的 min_vruntime（需 CONFIG_SCHED_DEBUG）
cat /proc/sched_debug | grep -A20 "cpu 0"

# 全系统视角：切换与等待
cat /proc/stat | grep ctxt        # context 行：累计切换次数
vmstat 1                          # cs 列：每秒切换增量
```

判读口径：`wait_sum / sum_exec_runtime` 比值高 → 排队严重（该扩容或限流）；`nw_migrations` 增速高且 `perf sched latency` 的 migrations 同步高 → 亲和性/均衡问题（第 8 章）；`vruntime` 与 `min_vruntime` 差距长期为负且绝对值大 → 该任务在"捡便宜"（典型为交互式高频唤醒）。

**本章要点：**

- CFS 把公平定义为"虚拟时间最终相等"：永远选 `vruntime` 最小者，跑得多的自动被追上。
- nice 是 1024 分制权重：每级 ×1.25，nice 0 vs 19 差 68 倍——比例公平，不是插队权。
- `min_vruntime` 是每队列基准线：唤醒、新建、迁移都以它为锚折算；睡眠不攒积分。
- 粒度三旋钮（latency/min_gran/wakeup_gran）控制公平与切换开销的平衡：就绪任务超阈值后切片摊薄，公平让位吞吐。
- buddy/唤醒抢占是交互性补丁，代价是权重公平有泄漏；`/proc/[pid]/sched` 是验证这一切的账本。

---

# 第 4 章：调度路径与上下文切换 - __schedule 的快与慢

## 4.1 什么时候做决定：调度点全集

调度不是后台线程在做，而是**在明确的事件点就地重新决策**（`kernel/sched/core.c`）。五类触发源：

```text
1 主动让出     schedule()：等锁/等IO/cond_resched/时间片耗尽
2 tick 抢占    时钟中断 → scheduler_tick() → 检查需否重新选择
               + 置 TIF_NEED_RESCHED，返回用户态时生效
3 唤醒         try_to_wake_up() → select_task_rq → 若新人更优，
               res_curr 目标 CPU 上的老人
4 阻塞入队     __schedule(prev 挂起) → pick_next → 换新人
5 显式迁移     stop_one_cpu / load_balance → migration 线程（stop 类）
```

**抢占是异步的**：置位 `TIF_NEED_RESCHED` 只是"留言"，真正换人要等到安全点（中断返回、用户态返回、显式检查点）。这个"留言→生效"的间隔就是**抢占延迟**——第 13 章的主角。

## 4.2 __schedule 主路径：从留言到换人

```c
/* kernel/sched/core.c 概念示意 */
__schedule(preempt)
  ├─ prev = rq->curr
  ├─ deactivate_task(rq, prev)    /* 若 prev 不再 runnable：摘树 */
  │     /* 阻塞：prev->on_rq=0，状态已 UNINTERRUPTIBLE */
  ├─ balance_callbacks / 负载均衡钩子
  ├─ pick_next_task(rq, prev)     /* 第 1.3 节的类位图扫描 */
  │     ├─ 快路径：fair 类直接 pick_next_entity（红黑树取根+buddy）
  │     └─ 慢路径：其他类存在 → 逐类询问
  ├─ context_switch(rq, prev, next)
  │     ├─ switch_mm(prev→next)   /* 地址空间：第 11 章 */
  │     ├─ switch_to(prev,next)   /* 寄存器/栈：arch/x86 宏 */
  │     └─ finish_task_switch     /* 上个任务真正退场（lazy） */
  └─ 更新统计：nr_switches、sum_exec_runtime、延迟账
```

三条快慢路径的工程含义：

1. **同 mm 切换极便宜**。内核线程（kworker/ksoftirqd）与用户任务切进切出，`switch_mm` 若 `next->mm == prev->mm` 直接跳过——`prev_mm` 走 lazy 模式（`use_mm`）。
2. **`pick_next_task` 快路径是 fair-only 检查**。绝大多数系统 99% 的调度在 fair 类内完成，位图扫描为这一情况特化。
3. **`deactivate_task` 与阻塞是一笔账**。任务每被摘树一次，`/proc/[pid]/sched` 的 `nr_switches` 加一；`voluntary_ctxt_switches`（主动）与 `nonvoluntary_ctxt_switches`（被动被抢）的比，直接告诉你该任务是"自己爱睡"还是"总被人踢"——`cat /proc/[pid]/status` 就能看，这是最便宜的定性分诊。

## 4.3 切换的真实成本

一次切换的直接开销与间接开销要分开算（x86_64 典型值，以本机微基准为准）：

```text
直接  保存/恢复寄存器组 + 栈指针切换          ~数百 ns
      内核路径开销（__schedule 本身）
间接  地址空间切换：CR3 写入 + TLB 局部失效    ~数百 ns 起
      缓存污染：L1/L2 被 prev 的工作集洗掉     ~us 级，取决于工作集
      KPTI 开启时每次进出用户态额外换页        ~us 级（第 11 章）
```

**数量级感受**：微秒级切换成本，在每秒 10 万次切换的系统里意味着 10% 的纯开销。`vmstat` 的 `cs` 列超过数万/秒就该警惕；容器化密集部署下，`cs` 常常比业务 QPS 涨得更快——因为每个 cgroup 的 throttling 入队出队都在制造切换。

> **关键认知**：把"切换次数高"直接当病因是归因错误。切换是结果不是原因——先回答**为什么切换**：是时间片被摊薄（第 3.4 节，就绪任务太多 → 扩容/限并发）、是频繁阻塞（IO 或锁 → off-CPU 分析）、还是被抢（RT/中断/高优先级 → 第 9/12 章）。`nonvoluntary_ctxt_switches` 占比高指向"被抢"，`voluntary` 占比高指向"自睡"，两条排查路径完全不同。

## 4.4 上下文切换的观测全家桶

```bash
# 系统级速率
vmstat 1              # cs 列；si 列顺带看软中断
pidstat -w 1          # 每任务 cswch/s（主动）与 nvcswch/s（被动）
                      # -w 是"切换特化视图"，比 top 精确到任务

# 事件级：谁换谁、隔多久
perf sched record -- sleep 5
perf sched timehist --state   # 逐切换展示：prev/next/cpu/延迟/等待
perf sched latency            # 按任务聚合的 wakeup→start 分诊表

# 内核函数级：切换路径上的热点
perf record -e sched:sched_switch -g -- sleep 10
perf report                   # 展开调用栈找"谁在逼我们切换"
```

**本章要点：**

- 调度在事件点就地决策：主动让出/tick/唤醒/阻塞/显式迁移五类触发；抢占是"留言→生效"两段式，中间间隔即抢占延迟。
- `__schedule` 三段式：摘树、选树（fair 快路径）、换人（switch_mm+switch_to）；同 mm 切换最便宜。
- 切换成本=直接（寄存器+CR3）+间接（缓存污染+KPTI）；`cs` 数万/秒就要立项查。
- `voluntary/nonvoluntary` 切换比是最便宜的分诊刀：主动高=自睡（查锁/IO），被动高=被抢（查优先级/中断）。
- `perf sched timehist/latency` 给出事件级账本，先分诊列（延迟/切换/迁移）再深挖。

---

# 第 5 章：PELT - 驱动所有决策的负载与利用率

## 5.1 瞬时值为什么不够用

调度器里至少四个决策需要"最近趋势"而不是"此刻快照"：负载均衡该不该迁人（迁过去可能立刻又回来）、唤醒放哪个 CPU（缓存还热吗）、EAS/DVFS 该给多少频率、以及过载检测。瞬时 `nr_running` 噪声太大——一个任务刚跑 2ms 就睡了，它对"这个 CPU 忙不忙"的贡献该怎么算？

PELT（Per-Entity Load Tracking，`kernel/sched/pelt.c`）的答案：**指数衰减滑动平均**。只记"当前这段连续状态"的起始时刻，平均值在读取时用几何级数现算，更新是 O(1)：

```text
概念（真实实现是查表定点数，非浮点）：
  新值 = 旧值 × y^(Δt/32ms) + 当前值 × (1 - y^(Δt/32ms))
  衰减周期 32ms，半衰期约 20ms 量级（以本机源码为准）
  含义：32ms 前的行为只打约一半折扣，64ms 前剩约四分之一
```

## 5.2 三本账：load、runnable、util

每个 `sched_entity` 维护 `avg` 结构（`include/linux/sched/stats.h`），三本账对应三个问题：

```text
util_avg       这段时间这个任务自己有多忙（跑/总）
               → 频率需求、EAS 放置、CPU 饱和度
runnable_avg   这段时间它是否排队（run+wait 都算 1）
               → 负载均衡的"任务数"度量
load_avg       runnable 但按权重折算（nice 加权）
               → 组调度与均衡时的"带权负载"
```

三者关系：`util ≤ runnable ≤ load`（同一尺度下）。一个 nice 19 的任务 `util_avg=1024`（满载），但 `load_avg` 只有约 15——**只看 load 会漏掉"占着 CPU 但不被公平计入"的忙人，只看 util 会低估排队深度**。`/proc/loadavg` 用的是 load 这本账（第 2 章），`load_balance` 迁移决策也主要看 load，`schedutil` 调频只看 util。

## 5.3 层级坍缩：一棵树上的可加性

PELT 的精髓定理：**子实体的平均值按" multiplier（该分支处于 runnable 的概率）"折算后，可以逐层加到父实体上**——于是"根 rq 上某个组的平均负载"可以直接从叶子任务一路乘加算出来，不需要遍历：

```text
leaf util_avg=800, multiplier 沿路径连乘
  → 子组 cfs_rq 贡献 = 800 × m1
  → 父组 se 的 runnable 期间贡献 = 子组聚合值
  → 根 rq 的 util_sum  = Σ 各顶层组的坍缩值
```

代价是近似：任务睡眠时 multiplier 归零，其组"看起来"空了——这正是**唤醒瞬间的 util 是滞后的**原因（组账本要等下次 update 才追上），也是 `select_idle_sibling` 有时"看走眼"的机制根源。

## 5.4 谁来读这些账

```text
fair 类负载均衡     load 账（第 8 章）
schedutil 调频      util 账（第 12 章）
EAS 容量放置        util 账 vs cpu_capacity（arm 异构）
cpu.max 配额        独立另一本 runtime 账（第 7 章）
PSI cpu 压力        runnable 与 all-stalled（第 15 章）
autogroup / 桌面    load 账
```

> **关键认知**：PELT 账本是"估算器"不是"计数器"。用 `avg.load_avg` 判断"这个任务重不重要"是危险的——一个每秒唤醒一次、每次跑 1ms 的任务，util_avg 只有约 100（10%），但它可能是你的 RPC 主线程，对调度延迟极其敏感。**负载度量回答"占了多少"，不回答"能不能等"**；后者要靠优先级策略（nice/RT）和压力指标（PSI）来表达。

## 5.5 观测：把 PELT 账本读出来

```bash
cat /proc/[pid]/sched | grep avg
#   se->avg.load_avg / runnable_avg / util_avg 三行
cat /proc/sched_debug        # 每 rq 每任务的 avgs.*（需 SCHED_DEBUG）

# 组级别：cgroup v2 的实时账
cat /sys/fs/cgroup/<grp>/cpu.stat
#   usage_usec（真实消耗）、nr_periods/nr_throttled/throttled_usec

# 每核 util（需要内核开了 CONFIG_SCHED_DEBUG 或走 /sys 的 cpufreq）
grep -H util /proc/sched_debug | head
```

判读口径：单任务 `util_avg` 接近 1024 且长期不降 → 真·计算密集，加核或优化算法；`runnable_avg` 高但 `util_avg` 低 → 它一直在排队（供给侧不足，查 throttling/隔离/RT 挤占）；组 `usage_usec` 增速远低于 limit 但 `throttled_usec` 非零 → 第 7 章的"配额真空"案例。

**本章要点：**

- PELT 用 32ms 衰减周期的指数滑动平均，把"最近趋势"做成 O(1) 可维护、可层级坍缩的账本。
- 三本账各司其职：util 管频率与饱和度、runnable 管排队深度、load 管加权负载均衡；`util ≤ runnable ≤ load` 不可混用。
- 层级坍缩是组调度的数学基础：叶子乘以路径 multiplier 连乘到根，无需遍历。
- PELT 回答"占了多少"，不回答"能不能等"——延迟敏感任务在 avg 账本里可能毫无存在感。
- 三个观测入口：`/proc/[pid]/sched` 的 avgs、`/proc/sched_debug`、cgroup `cpu.stat`。

---

# 第 6 章：EEVDF - 6.6 把"时间的公平"换成"欠账的公平"

## 6.1 CFS 的结构性欠账

CFS 的 `vruntime` 只记"跑掉的"，不记"没跑到的"。三个长期问题（Peter Zijlstra 在 6.6 合并说明里的批评要点）：

```text
1 睡眠任务醒来按 min_vruntime 入队 → 它欠的"没跑的时间"清零重来，
  高频短暂唤醒者靠 buddy 启发式白拿份额（第 3.5 节的泄漏）
2 无请求粒度概念：无法表达"我想跑 10ms 还是 1ms"，
  时间片只能由权重和任务数倒推
3 延迟目标模糊：CFS 承诺"每 sched_latency 一轮"，
  但对单个任务"醒来多久内必须上"没有硬约束
```

EEVDF（Earliest Eligible Virtual Deadline First，算法学术上 1995 年就有）把模型换成**请求-服务-欠账**三元组。

## 6.2 模型：deadline 决定顺序，eligibility 决定资格

每个任务有两样东西：

```text
请求粒度（slice）    本轮想跑多大一片；默认由权重和周期推得，
                     可用 sched_attr 显式声明（6.6+ 的精细控制入口）
虚拟 deadline        = 上次唤醒时刻 + (delay + request) / 2
                     delay = 服务轮次（等得越久轮次越靠后）
```

每轮 `pick_next` 的裁决：**在 eligible 集合（lag ≥ 0，即没跑够本分）里，选 deadline 最早的**。两个词各自管一半：

```text
eligibility（资格）  用 lag 记账：欠跑的（没跑够份额）lag 为正，
                     优先获得出场资格；跑超了的 lag 为负，先坐冷板凳
deadline（顺序）     有资格的里面，谁的"承诺完成时间"早谁先跑
```

红黑树还在，key 从 `vruntime` 换成 `deadline`；`vruntime` 退位成 lag 账本的换算基准（`vgate`/`min_vruntime` 语义调整，细节以 `kernel/sched/fair.c` 本机版本注释为准）。

## 6.3 对运维意味着什么

行为层面的变化（6.6 前 vs 6.6 后，同负载对比实测为准）：

```text
交互式小任务      lag 天然为正 → 醒来即 eligible，无需 buddy 补丁
                  → 唤醒延迟的最大值通常显著下降
高频"捡便宜"消失  份额用 lag 定量结算 → 权重公平泄漏收敛
延迟指标          内核新增 GVE（Gap Violation Estimation）：
                  runnable 但等待超 deadline 欠账的量化统计，
                  /proc/sched_debug 与 tracepoint 可见（以本机源码为准）
时间片可调        应用可用 sched_attr(setattr) 声明请求粒度，
                  这是 CFS 时代没有的控制面
```

> **关键认知**：EEVDF 没有改变 CFS 的世界观——它仍是 fair 类、仍讲权重比例、仍是红黑树选点。它改变的是**记账方式**：从"比谁跑过的虚拟时间少"到"比谁欠账多且承诺到期早"。所以第 3 章学的权重/粒度/min_vruntime 不是作废，而是升级；容器 throttling、cgroup 权重、nice 语义在 EEVDF 下全部保留。**版本判断要看实际内核**：部分发行版在 6.1/6.5 回合了 EEVDF，6.12+ 引入 sched_ext 后 EEVDF 仍是默认 fair 类；`uname -r` + `/sys/kernel/debug/sched/` 可调项是两代算法最直观的指纹。

## 6.4 观测：识别你在跑哪一代

```bash
# 可调项指纹：CFS 有 wakeup_granularity，EEVDF 有 base_slice 等
ls /sys/kernel/debug/sched/
#   CFS 时代常见：sched_latency_ns / min_granularity_ns /
#                 wakeup_granularity_ns
#   EEVDF 时代：base_slice_ns（以本机内核实际列表为准）

# 事件级对比：升级前后各跑一次
perf sched latency
#   关注 Maximum 列的改善幅度 → GVE 式长尾是否收敛

# 内核 tracepoint（6.6+ 相关事件名以本机 perf list | grep sched 为准）
perf list | grep -i sched
```

判读口径：`/sys/kernel/debug/sched/` 出现 `base_slice_ns` 而无 `wakeup_granularity_ns` → EEVDF；反之 CFS。对延迟敏感服务做内核升级评估时，**比较 `perf sched latency` 的 Maximum 列而不是 Average 列**——EEVDF 的主要收益在尾部。

**本章要点：**

- EEVDF 的动因：CFS 的睡眠重置、buddy 泄漏和无请求粒度三个结构性缺陷，本质是"欠账没被记账"。
- 模型：请求粒度 + 虚拟 deadline；在 eligible（lag≥0）集合中选 deadline 最早者——资格管欠账，顺序管承诺。
- 结构不变、记账变：还是 fair 类、权重、红黑树；vruntime 退居换算基准，key 换成 deadline。
- 运维收益主要在尾部延迟与交互式任务；GVE 统计是新的事件级证据源。
- 发行版回合情况复杂：用 `/sys/kernel/debug/sched/` 的可调项列表指纹判断代际。

---

# 第 7 章：cgroup cpu.max - 配额、周期、burst 与 throttling

## 7.1 配额的物理含义：一个容易误解的除号

cgroup v2 的 CPU 带宽控制就一个文件：

```bash
cat /sys/fs/cgroup/web/cpu.max
#   400000 100000   → quota=400ms / period=100ms
#   max 100000       → 不限制，只吃权重（cpu.weight）
```

`400000/100000` 常被读成"限 4 核"。**错了一半**：它真正的含义是"**每 100ms 真实时间内，该组所有线程合计最多消耗 400ms CPU 时间**"。差异在并行消耗速度上见分晓：

```text
时间线（quota=400ms, period=100ms）：
 t=0ms     8 个线程同时在跑，消耗速率 8 核·时间/时间
 t=50ms    quota 耗尽 → 8 个线程全部挂进 throttled 链表
           （它们仍是 runnable，但调度器拒绝再选中）
 t=100ms   hrtimer 周期边界 → replenish → 重新入队
 现象：平均速率确实"4 核"，但墙钟上有 50ms 的真空气泡，
       气泡期间的请求延迟直接 +50ms，且周期重复 → P99 崩盘
```

> **关键认知**：这就是"宿主 CPU 不高、容器 CPU 也不满 limit 的平均值，但业务仍然被限流"的机制真相——**quota 是时间预算不是并发额度**。平均用量 2 核、峰值并发 8 线程的负载，在 4 核 quota 下必然撞墙，哪怕 10 秒平均下来远未用满。K8s 里 `requests=limits=4` 的 Java 服务（GC 并行线程轻松 >8）出现周期性 GC 长尾，第一嫌疑人就是它。

## 7.2 throttling 的代码路径

```text
周期性消耗：
  account_cfs_rq_runtime()          每次 tick/边界从 cfs_b->runtime
  （cfs_b = group 的 bandwidth 结构）  扣掉本次 slice
  → runtime <= 0 时 assign_cfs_rq_runtime 返回失败
  → enqueue_task_fair 路径把子 cfs_rq 从父树摘除，
    挂进 cfs_b->throttled_cfs_rq，rq 上挂 throttling hrtimer
周期边界：
  sched_throttled_hrtimer → do_sched_cfs_period_timer
  → distribute_cfs_runtime：从全局池 replenish
  → unthrottle_cfs_rq：重新挂回父树，被限任务恢复可选
```

三个结构点：

1. **runtime 是全局池**。组在所有 CPU 上的 `cfs_rq` 向同一个 `cfs_b->runtime` 批发（每次 `slice=period` 零售额度），并行线程消耗快是因为各自都领到了零售配额——**全局池不防并行峰值**。
2. **throttled 任务不计入 PELT util**（它们在"被扣押"），但计入 runnable/load——这就是"quota 打满时组在 `cpu.stat` 里 usage 封顶、而全局 `r` 却在涨"的错位来源。
3. **hrtimer 对齐周期边界**。缓解"气泡"的正规手段是**缩短 period**（如 `400000 20000`：quota 小、周期 20ms，气泡最多 20ms，代价是分发开销上升）——6.6+ 另有 `cpu.max.init_buffer` 等微调（以本机源码为准）。

## 7.3 burst：给突发流量一个信用账户

```bash
# 5.14+ 引入 credit 式 burst；文件名 cpu.burst 或 cpu.max.burst
# 随版本演变，以本机内核/发行版为准
echo 200000 > /sys/fs/cgroup/web/cpu.max.burst   # 允许借用 200ms 突发
cat /sys/fs/cgroup/web/cpu.stat | grep burst
#   nr_bursts / burst_usec：用了多少信用
```

语义：**平时用不完 quota → 攒成 burst 信用（上限就是所设值）→ 突发时透支**。适合"平时安静、峰值要快"的 RPC/网关型服务；不适合持续高并发负载（信用立刻枯竭，退化成无 burst）。注意它不解决 7.1 的"气泡"——burst 放大的是额度总量，并行峰值照样在同一周期内撞墙。

## 7.4 权重侧：cpu.weight 与共享模型

quota 之外，没有限额时靠**比例**竞争：

```text
cpu.weight      1..10000，默认 100（v1 的 cpu.shares 值域不同：
                2..262144，换算 ≈ shares = 1024 × weight/100，
                以本机内核换算函数为准）
两个组在同一个父队列：空闲时都能跑满；争抢时按 weight 比例分配
```

K8s 语义映射要记牢：`requests`（CPU）→ 权重（`cpu.weight`/份额），`limits`（CPU）→ `cpu.max` quota，`limits: requests` 比值即 **BurstRatio**——比值越大，节点超卖越狠、单容器被 throttling 的阈值越低；`Guaranteed`（requests=limits）仍可能被限，因为它只是权重相等，quota 气泡问题原样存在。

## 7.5 观测与决策表

```bash
# 限流三件套：周期数 / 被限次数 / 被限总时长
cat /sys/fs/cgroup/web/cpu.stat
#   nr_periods  nr_throttled  throttled_usec（v1 同名）

# 全节点视角：哪个容器在被限（只看非零行）
grep -H nr_throttled /sys/fs/cgroup/kubepods*/**/cpu.stat

# 实时事件（需 tracepoint）
perf trace -e sched:sched_stat_runtime,sched:sched_switch ...
# 或 bpftrace 统计 throttled 直方图（工具生态以本机可用为准）
```

| 信号 | 解释 | 动作 |
| --- | --- | --- |
| nr_throttled/nr_periods 高（>10%） | quota 与并行峰值不匹配 | 提 limit/调 period/上 burst 三选一 |
| throttled_usec 大但气泡频率低 | 偶发突发 | burst 优先 |
| usage_usec 长期贴顶 quota | 真的需要更多 | 提 limit 或扩副本 |
| limit 删掉（max）仍延迟长尾 | 不是 quota 问题 | 查权重挤占/均衡/供给侧 |
| 节点 Pod limit 总和 >> 核数 | BurstRatio 过高 | 治理 requests=limits |

**本章要点：**

- quota/period 是**每周期的时间预算**，不是并发额度：并行线程数越多，同一周期内撞墙越快，产生周期"真空气泡"。
- 宿主/组平均 CPU 不高仍被 throttling 的真相 = 并行峰值打爆周期内 quota；GC、线程池类负载是高发人群。
- 代码三件套：`account_cfs_rq_runtime` 扣账、`throttled_cfs_rq` 扣押、周期边界 `distribute_cfs_runtime` 发还；hrtimer 对齐 period。
- burst 是信用账户（平时攒、突发花），缓解总量突发但不消气泡；缩短 period 才治气泡。
- v2 `cpu.weight`/v1 `cpu.shares` 管无争抢时的比例；K8s requests→权重、limits→quota，比值即超卖度。
- 决策表先对 `cpu.stat` 的三个 throttled 指标分类，再决定提额/改周期/上 burst/摘 limit。

---

# 第 8 章：cpuset、亲和与负载均衡 - 任务如何铺到核上

## 8.1 cpuset：静态圈地

cgroup v2 的 cpuset 控制只有两个有效入口（`kernel/cgroup/cpuset.c`）：

```bash
cat /sys/fs/cgroup/app/cpuset.cpus      # 允许用哪些 CPU，如 0-3,8-9
cat /sys/fs/cgroup/app/cpuset.mems      # 允许用哪些 NUMA 节点
```

规则链：非根 cpuset 的集合 ⊆ 父集合；调度时实际可用 = **cpuset ∩ 任务自身 affinity**（`sched_setaffinity` 设的 mask）；两者矛盾时 cpuset 赢（任务被赶回圈内）。`cpuset.cpu_exclusive`（v1 概念，v2 用 "exclusive_root_cpus" 机制表达，以本机为准）决定圈是否独占。

> **关键认知**：绑核（cpuset/affinity）是**把调度权没收**——你替内核做了"这个任务永远在这几个核"的决定，此后负载均衡不再救它。核少了，排队概率上升；而内核的缓存亲和优化（wake_affine 的 CPU 选择、select_idle_sibling）也全部失效。所以"绑核降延迟"的收益只在**核数仍够用**的前提下成立；绑完之后 `r` 长期超过圈内核数，长尾会比不绑更糟。K8s CPU Manager 的 `static` 策略就是 cpuset 整核分配，收益是确定性、代价是弹性归零。

## 8.2 唤醒放置：wake_affine 与 select_idle_sibling

任务醒来（`try_to_wake_up`）选 CPU 的快路径（`kernel/sched/fair.c`）：

```text
1 prev 核还空闲或很快空闲？ → 赌一把放回去（缓存热）
   wake_affine 比较 prev/new 两边的负载均衡度与缓存热度
2 否则在目标域内找 idle core：
   select_idle_sibling → 同 LLC 内轮询找完全空闲的核
   （SMT：同物理核的兄弟线程优先于跨 LLC 的空闲核）
3 都没有 idle → 放进 rq，靠后续 load_balance 补救
```

这条快路径解释了 `perf sched latency` 里"migrations 少但 Average 延迟高"的一种典型：**唤醒时被放到一个"看起来 idle 其实马上有人来"的核**——select_idle 的乐观在超高并发下频繁失手。

## 8.3 sched_domain 树：均衡的行政层级

负载均衡不是全系统一锅烩，而是沿一棵**域树**逐级进行（`build_sched_domains`，`kernel/sched/topology.c`）：

```text
域树（x86 双路大 LLC 示例，arm 另有 EAS 容量域）：
  SMC/SMT    同一物理核的逻辑 CPU     周期最短，迁移最廉
  MC         LLC 内各核（共享 L2/L3） 热数据不出 LLC
  NUMA/DIE   跨 socket/跨节点         周期长，且带缓存惩罚账
```

每域独立周期（约 1ms/2ms/4ms… 逐级翻倍，具体常数以本机 `sd->balance_interval` 为准），每域独立做 `load_balance`。x86 上 `SD_ASYM_PACKING`、arm 上 `asymmetric_cpu_capacity` 决定"快核优先吃任务"的异构语义。

## 8.4 load_balance：什么时候搬、什么时候不搬

pull 方向（主动去别人队列取）的核心逻辑（`load_balance()`）：

```text
1 本 rq 快闲了/定时到点 → 遍历域内其他 rq，按 load 账挑最肥的组
2 过"busyness"检查：
   group_busy / group_is_overloaded ——对方忙得不可开交？
   → 不搬它的"忙任务"，只搬"睡后醒来排队中"的（migration cost
     按 decay_threshold 随睡眠时长打折——搬一个刚睡下的便宜，
     搬一个正跑火的贵）
3 拉不到 → 推方向：过载 rq 用 stop_one_cpu 派 migration 线程强搬
4 NUMA 域多一层 imbalance 计算 + 任务归属偏好（numa_overhead）
```

三个反直觉点：

1. **"忙核上有排队、闲核上没人"不一定会立刻搬**——busyness 门槛故意容忍短期不均，防止迁移抖动（搬过去 2ms 后又想回来，两边缓存都凉了）。
2. **migration 成本是指数衰减的账**：`task_hot`（缓存热度估计）参与折算，热任务的迁移门槛远高于冷任务。
3. **过载兜底靠 stop 类线程**：`migration/N` 内核线程优先级最高，它频繁出现在 `perf top` 里，说明 pull/push 已经追不上不均了。

## 8.5 隔离工具箱：isolcpus / nohz_full / rcu_nocbs

给实时/高性能负载圈"无人区"的三板斧（启动参数，`kernel/sched/isolation.c`）：

```text
isolcpus=managed_irq,domain,2-5   均衡器不往这些核派普通任务
nohz_full=2-5                     这些核上单任务运行时停 tick
                                  （消除周期性 tick 抖动）
rcu_nocbs=2-5                     RCU 回调不在此核执行，
                                  由 rcuox 工作线程代跑
```

配套动作缺一不可：**把这些核的中断移走**（`irqbalance` 禁用或 `/proc/irq/N/smp_affinity` 手工钉；timer 中断在 5.15+ 可走 `nohz_full` 的 timer migration 豁免，以本机文档 `Documentation/ABI/.../kernel-parameter` 与 admin-guide 为准）；内核线程也要赶（`cpuset` 根组或 `systemd` 的 `CPUAffinity=` 设给业务之外）。HPC/低延迟数据库的"绑核抖动"排障里，**isolcpus 核上仍出现 kworker/rcu** 是经典事故——隔离只做了调度一层，没做中断/RCU/内核线程三层。

**本章要点：**

- cpuset 是静态圈地，实际可用 = cpuset ∩ affinity，冲突时 cpuset 赢；绑核=没收调度器的缓存亲和优化，圈内排队风险自负。
- 唤醒放置赌"prev 核还空"和"同 LLC idle core"；超高并发下 select_idle 的乐观是延迟毛刺的隐性来源。
- 负载均衡沿 sched_domain 树逐级做：SMT→MC→NUMA，周期递增、成本递增；busyness 门槛和 task_hot 衰减账决定"忙而不搬"。
- 过载兜底靠 stop 类 migration 线程；它上 `perf top` 说明均衡器已追不上不均。
- 隔离三板斧 isolcpus/nohz_full/rcu_nocbs 必须配齐中断、RCU、内核线程三层，缺一层隔离就漏。

---

# 第 9 章：中断与 softirq - 抢占你 CPU 的"隐形人"

## 9.1 中断上下文：三种"不可"

硬件中断到来时，CPU 不管调度器同不同意就跳进中断处理程序——这就是**硬中断上下文**，它的三条铁律（`kernel/irq/handle.c`、`__do_softirq`）决定了它的全部行为：

```text
1 不能睡眠        没有可阻塞的"任务"概念，mutex/拷贝到用户态都不行
2 优先级在调度之上  普通任务即使 SCHED_FIFO 也会被中断打断
                  （除非该核中断被屏蔽/迁移）
3 抢占默认关闭     中断处理期间 this_rq 上的任务被"借走"CPU，
                  这段时间记入 /proc/stat 的 irq 桶
```

所以"CPU 满"的第二副面孔出现：`mpstat -P ALL 1` 的 `%irq`/`%soft` 高，**业务任务其实一直在排队等中断腾手**——此时加核无用，要先治中断。

## 9.2 softirq：下半部的批处理预算

硬中断只许做最少的事（收 ACK、触发 DMA），剩下的推迟到**软中断**。实现要点（`kernel/softirq.c`）：

```text
raise_softirq(X)      置 per-CPU 位图，在中断返回路径检查
__do_softirq()        返回用户态/中断退出时批量执行
  预算：最多跑 2ms 或 10000 次循环（常数以本机源码为准）
  超预算 → 唤醒 ksoftirqd/N，把它降级成普通可调度任务慢慢跑
  注意：执行时仍关抢占，且它排在所有正常任务之前
```

八种 vec 按优先级固定序执行（TIMER、NET_TX、NET_RX、BLOCK、IRQ_POLL、TASKLET、SCHED、HRTIMER、RCU），同一轮内高优先级没跑完会饿低优先级——**网络 softirq 风暴拖慢块设备回写**就发生在这条优先级链上（IO 篇第 14 章 PSI io 会再遇到它）。

## 9.3 ksoftirqd 的两种解读

`ksoftirqd/N` CPU 占用高，含义完全取决于上下文：

```text
ksoftirqd 忙 + 该核 %soft 不高   → 软irq 被主动让路（预算耗尽后
                                   降级排队），系统还健康
ksoftirqd 忙 + 业务线程排队加深    → 软irq 量超过了"顺路处理"能力，
                                   已经需要专门任务时间；
                                   NET_RX 积压 → 查网卡队列/backlog
```

> **关键认知**：看到 `ksoftirqd` 就"杀中断绑定"是经验性归因。先算增量账：`/proc/softirqs` 两拍之差按 vec 拆开——`NET_RX` 涨 → 网络收包（NAPI 预算/队列分布）；`BLOCK` 涨 → 块完成中断（盘快但中断集中）；`RCU` 涨 → 内核对 rcu_read_lock 滥用过敏（高频读侧）；`TIMER` 涨 → 定时器风暴（高频 hrtimer/queue_work_on）。哪个 vec 涨，病根就在哪条产线。

## 9.4 网络 softirq 的流量整形三件套

网卡收包默认在**硬中断所在 CPU** 的 softirq 里完成协议栈处理。三个可调层（`net/core/`）：

```text
RPS   软件中断负载均衡：把 skb 再哈希分发给指定 CPU 的 backlog
      （/sys/class/net/*/queues/*/rps_cpus）
RFS   在 RPS 上加"跟进程走"：查 flow_to_cpu 表把包送到
      正在处理它的应用线程所在核（缓存亲和）
XPS   发送侧对称版：map 决定哪个队列由哪个 CPU 触发
NAPI  批量轮询：单次 softirq 处理上限 budget=64 包
      全局 netdev_budget(300) / netdev_budget_usecs 兜底公平
```

高吞吐排障经典配置病：网卡多队列但 irq affinity 全绑 CPU0（`/proc/interrupts` 一眼看穿），或 RPS 开在 NUMA 跨节点核上——**包处理完了，数据已经在远端内存**。判据：`perf top` 里 `process_backlog`/`net_rx_action` 热点集中 + `sar -n DEV` 队列不均。

## 9.5 threaded interrupt：把中断变成任务

`request_threaded_irq`（`kernel/irq/manage.c`）把 handler 拆成"硬中断头 + `irq/名-N` 内核线程"两半。收益是**可调度**：线程有优先级、能被负载均衡挪走、能被 cgroup 圈住。三个配置语义：

```text
CONFIG_IRQ_FORCED_THREADING   启动 irqpoll/force_thread_irq 全量线程化
threaded=... 单个 irq 的 /proc/irq/N/threaded 可见
PREEMPT_RT  下大部分 irq 强制线程化（第 12 章）
```

观测入口：`top` 里 `irq/44-nvme` 这类线程名——**NVMe 中断被线程化后，中断处理时间从 %irq 桶搬进了 %system 的任务时间**，看 `/proc/interrupts` 会"变干净"，别被误导。

## 9.6 中断亲和与 NUMA 对齐

多队列网卡/NVMe 的中断按队列分散到各 CPU（`/proc/irq/N/smp_affinity` 或 `smp_affinity_list`）。对齐原则：

```text
设备中断 → 钉到"设备本地 NUMA 节点"的核
         → 再与上层线程（RQ 处理线程/消费者）同节点
irqbalance 自动做上述两件事（需要 daemon 版本支持
numa affinity，老版本只管忙闲不管远端——以本机为准）
隔离核场景必须手工把 irq 移出（第 8.5 节配套）
```

验证命令：

```bash
cat /proc/interrupts | column -t   # 每 irq 每 CPU 计数
watch -n1 "grep -E 'eth|nvme' /proc/interrupts"   # 看增量分布
# 增量只堆在少数列 → 亲和没铺开；整列都堆在 node0 → 本地性 OK
```

**本章要点：**

- 硬中断在调度优先级之上且不能睡眠；`%irq/%soft` 高时业务排队的病根在"被借走的时间"，加核无效。
- softirq 有 2ms/10000 次预算，超支降级到 ksoftirqd；`/proc/softirqs` 按 vec 的增量是分诊第一刀。
- ksoftirqd 忙 ≠ 故障：先看它是不是"主动让路"，再按 NET_RX/BLOCK/RCU/TIMER 定位来源产线。
- RPS/RFS/XPS/NAPI 构成网络软中断的流量整形层；配置病 = 中断单核堆积或跨 NUMA 处理。
- 中断线程化（irq/N 线程、RT 强制）让中断可调度，但会把时间从 %irq 桶挪进任务账，观测口径要跟着换。

---

# 第 10 章：频率与 idle 深度 - 供给侧的两本暗账

## 10.1 "100% 占用率"的分母在漂

调度器眼里的 CPU 是布尔的（跑/没跑），`/proc/stat` 按这个布尔记账。但**同样的 1% 占用率，算力可以差好几倍**——频率从基频 2.4GHz 漂到睿频 4.0GHz，或在 AVX 重负载下被压到低于基频。分母在漂，分子（占用时间）却照常进账，这就是"占用率不等于有效算力"的物理根源。

供给侧三本暗账：

```text
P-state（性能态）  OS 或硬件自主的调频/调压
C-state（空闲态）  核/簇/封装级深度休眠，退出要付延迟
ITMT/睿频协作      同一插槽共享功耗预算：核越少醒着，
                  单个能爬多高；全核忙时大家频率都低
```

## 10.2 schedutil：把 util 账直接映射成频率

现代默认 governor 是 `schedutil`（`kernel/sched/cpufreq_schedutil.c`）：**读 PELT 的 util 账，反查容量曲线出频率请求**：

```text
rq 的 util_avg（含被 boost 的部分） → capacity inverse
→ target freq → 经 rate_limit 节流（约一个 tick 一次）发给驱动
util 归零 → 回落 idle 频率；频率上升是"提前拉"（唤醒即算）
```

三个常见误区：

1. **util 估算不足 → 频率上不去**。短突发任务（每次跑 <1ms 就睡）的 util_avg 低，schedutil 慢半拍才拉频——微基准测出"延迟忽快忽慢"可能是 governor 而非调度。对策：延迟敏感部署用 `performance` governor 锁频（代价：功耗/发热/睿频预算）。
2. **cgroup 的 util ≠ 频率承诺**。限了 `cpu.max` 不代表频率变低；配额账（第 7 章）与频率账（本章）互不通信。
3. **虚拟化里 OS 只能请求**。guest 的 cpufreq 写入可能被 hypervisor 忽略（云实例频率由宿主策略决定）——`scaling_cur_freq` 读到的是"报告值"，云厂商甚至不报告真实频率；实测用 `perf stat` 的 cycles vs task-clock 比值推算。

## 10.3 C-state：睡眠越深，唤醒越贵

`cpuidle`（`drivers/cpuidle/`）管理空闲态菜单：C0（运行）、C1（浅睡，退出 ~us 级）、C6（深度，电压门全关，退出可达 ~百 us）。governor（6.x 默认 teo，此前 menu，以本机为准）按"下一个事件预测多久来"选睡多深：

```text
预测空闲久 → 睡 C6：省电，但下一个唤醒多花几十 us 退出
预测空闲短 → 睡 C1：响应快，费电
调度抖动排障：高频短暂唤醒负载 + 深度 C-state =
"每个包都比上一包晚 50us"的元凶
```

控制入口：`/sys/devices/system/cpu/cpu*/cpuidle/state*/disable`、`cpupower idle-info` 看各态延迟。**低延迟调优的标准动作之一：禁掉 C1E 以上深睡**（代价：空转功耗飙升——笔记本/云按预算取舍）。

## 10.4 睿频的另一面：AVX offset 与热预算

Intel 的许可机制会让"忙"反噬"快"：

```text
AVX-Heavy Offset  重指令集执行一段时间后，允许频率压到
                  基频以下（licensing 账本，turbostat 可见）
Core Capping      封装功耗触顶 → 逐核降频
Thermal Throttle  温度墙 → 强制 P-state 下调（MSR 0x19C 位，
                  turbostat 直接给"throttle 原因"列）
```

排障话术：`业务没变但整体慢 5%` → 先看 `turbostat` 的 Bzy_MHz 与 PkgTmp 是否贴墙，而不是先看负载分布。**频率没上去的 100% 忙，和算力被抽走的 100% 忙，调度器视角一模一样**。

## 10.5 SMT：两个线程分一份执行单元

超线程共享同一物理核的流水线和 L1/L2：两个 busy 线程各报 100% 占用率，真实吞吐通常只有单线程的 1.2-1.3 倍（微架构与工作集相关）。调度器的处理：SMT 域内 load 按"每核一份"聚合（第 8.3 节），`select_idle_sibling` 优先给整核空闲的。运维含义：

```text
容量测算：按"逻辑核数"做 quota 会高估 SMT 对半开场景的算力
延迟隔离：RT/延迟敏感任务独占物理核（cpuset 成对选兄弟线程）
ITMT：同插槽内"谁醒着"影响各自可达频率 → 绑核可能意外降睿频
```

> **关键认知**：CPU "满载"有三层账要分别问：调度层（rq 有没有排队的人）、能耗层（频率是否到标称）、微架构层（执行单元被 SMT 兄弟/AVX/热分摊多少）。`vmstat` 的 r 列、`turbostat` 的 MHz、`perf stat` 的 `cycles:task-clock`——三件套齐了才叫"供给量清楚"。

**本章要点：**

- 占用率的时间分母会漂：P-state 调频、C-state 唤醒延迟、ITMT/睿频协作、AVX/热封顶共同决定 1% 占用率的真实算力。
- schedutil 把 PELT util 直接映射成频率：短突发任务频率响应慢半拍是 governor 行为，不是调度 bug。
- C-state 深度与唤醒延迟成正比：高频短暂唤醒负载的"每包 +50us"先查 cpuidle。
- 频率触顶/触墙用 turbostat 取证（Bzy_MHz、throttle 原因列），虚拟化下 guest 报告值不可尽信，用 cycles/task-clock 推算。
- SMT 让"双 100%"只有一份额外算力：容量测算与延迟隔离都要按物理核口径。

---

# 第 11 章：switch_mm、PCID 与 KPTI - 上下文切换最贵的一笔

## 11.1 换页表基址发生了什么

第 4 章说过同 mm 的切换跳过 `switch_mm`；跨 mm 时（`arch/x86/mm/tlb.c`）：

```text
写 CR3（新 pgd 物理地址 + PCID tag）
  ├─ 旧地址空间的 TLB 条目"逻辑上"作废
  ├─ 内核映射是否共享：普通 CR3 切换 → 全刷
  └─ PCID 时代：条目带着进程 tag 保留，换回该进程即复用
```

**PCID（Process Context IDentifier）** 把"换页表基址"从"清空 TLB"解耦：CR3 写入附带 12-bit tag，TLB 条目记住自己属于哪个 tag——切走再切回，用户态映射还在。代价是 tag 数量有上限，会轮转回收（`choose_new_asid` 的 ctx 世代翻转时局部 flush）。

## 11.2 KPTI：Meltdown 补丁的持续税

2018 年 Meltdown（乱序执行可以窥探内核映射）逼出 **KPTI**：用户态页表里根本不存在内核映射，每次陷入内核/返回用户态都要**切一次页表基址**（`entry_64.S` 的 trampoline）。

```text
KPTI 之前：内核映射全局共享，系统调用进出不换页表
KPTI 之后：每次用户↔内核边界 = 一次 CR3 写入
  缓解：PCID 让这次切换只需换 tag 而非全刷
  （kernel 用 PCID=0/1，user 用进程 tag）
  残余成本：边界上多几十~几百 cycle + TLB 压力
```

系统调用密集型负载（`sy` 高、tinyio 微基准）上 KPTI 的税可测：`dmesg | grep -i 'mitigation'` 确认开着；`perf stat -e context-switches` 与 syscall 计数对比。关 KPTI（`no_vsyscall`/`mitigations=off`）换性能是**安全权衡**，只在内网可控+物理可信场景评估。

## 11.3 TLB shootdown：改一个映射，惊动所有核

页表是共享数据结构，但 **TLB 是各核私有的缓存**。`munmap`/`mprotect`/页迁移改变了多进程共享的映射，内核必须让所有可能缓存了旧条目的核自己作废——`flush_tlb_mm_range` → 对每个相关 CPU 发 IPI（函数调用中断），等同步确认：

```text
发起核：改页表 → 收集"谁映射了这片"（mm_cpumask，超核数退化为保守）
       → smp_call_function 发 IPI
目标核：中断里 invlpg / invlcpid → 回报
成本：一次 IPI 往返 ~us 级；目标核越忙、核数越多越贵
     集中表现为 munmap/mprotect 系统调用延迟长尾
```

高发人群（与内存篇第 3/6 章对接）：频繁 `mmap/munmap` 的分配器（glibc mmap 阈值以上的 arena、jemalloc）、`MADV_DONTNEED/FREE` 高频使用、页迁移/compaction（把共享映射页挪家）、`MADV_PAGEOUT`。**症状指纹：`sys` 高但 `perf report` 热点在 `smp_call_function_many`/`flush_tlb_mm_range`，而不是业务函数。**

> **关键认知**：TLB shootdown 风暴是"跨核同步成本"伪装成"内核 CPU 高"。一个单线程反复 mmap/munmap 的进程，能让**其他所有空闲核**从 C-state 被 IPI 拽醒陪葬——`mpstat -P ALL` 里"没人干活但人人 sy 高"是它的招牌画像。治法是减少映射变更次数（分配器改 arena 复用、用 `MADV_FREE` 换延迟释放、THP 降低条目数），而不是加核。

## 11.4 观测工具箱

```bash
# 边界成本：切换频率（进程间 mm 不同才会走到这些路径）
perf stat -e context-switches,cpu-migrations sleep 10
# 页表刷新的细账（内核事件名以 perf list 为准）
perf record -e tlb:tlb_flush -a sleep 5
perf record -e irq:irq_handler_entry -a   # 顺带看 IPI 频率
cat /proc/softirqs | head -2               # FUNCTION/CPU_CALL 列增量
# 系统调用边界密度：直接数 syscall 事件
perf trace -a --summary sleep 5
```

判读链：`context-switches` 高 → 先回第 4 章分诊主动/被动比；`tlb_flush` 的 reason 含 `flush_tlb_mm_range` 且集中在少数进程 → shootdown 源头锁定；IPI（FUNCTION CALL/CPU CALL 桶）增量与某进程 `munmap` 计数同涨 → 证据闭环。

**本章要点：**

- 跨 mm 切换的本质是写 CR3；PCID 把"切基址"与"清 TLB"解耦，切回原进程可复用旧条目。
- KPTI 给每次用户/内核边界加一次页表切换税，syscall 密集负载可测；关闭是安全权衡，非纯性能开关。
- TLB shootdown = 改共享映射惊动所有映射者核的 IPI 同步，成本随核数与目标忙度放大。
- 高发源是 mmap/munmap/madvise/页迁移密集的操作；"人人 sy 高、干活的核只有一个"是招牌画像。
- 证据三件套：perf 的 context-switches/tlb_flush tracepoint/IPI 桶增量，与嫌疑进程 syscall 计数对齐即闭环。

---

# 第 12 章：抢占模型与 RT/Deadline - 实时性的四档配置

## 12.1 四种内核抢占档位

编译期选择（`kernel/Kconfig.preempt`），决定**内核态代码多快能让位于更高优先级任务**：

| 模型 | 内核何时可被抢 | 延迟下限 | 吞吐 |
| --- | --- | --- | --- |
| PREEMPT_NONE | 只在显式 cond_resched/返回用户态 | 毫秒级 | 最高 |
| VOLUNTARY | cond_resched 点位更多 | 毫秒~亚毫秒 | 略降 |
| PREEMPT（低延迟） | 非临界区自旋锁/中断外皆可抢 | 数十 us~亚毫秒 | 降 1-3% 级 |
| PREEMPT_RT（6.x 主线化） | 自旋锁可变睡眠、irq 全线程化 | 亚百 us 级 | 明显降 |

关键概念：**抢占延迟 = 任务被置 TIF_NEED_RESCHED 到真正换上的时间**，其上限由"最长不可抢占临界区"决定——`spin_lock` 关抢占区、`local_irq_disable` 区、seqlock 写侧都是账。`PREEMPT_RT` 的改造正是把这些临界区逐一变成可睡眠对象。

## 12.2 测抢占延迟的方法

```text
cyclictest（rt-tests 套件，用户态最标准工具）：
  cyclictest -t1 -p80 -n -i 100000 -l 10000 -m
  # 一个 SCHED_FIFO 线程每 100ms 睡醒一次，
  # 报告每次"醒来→真正跑上"的最大延迟
内核侧取证（延迟来源归因）：
  trace-cmd record -e preemption_disable -e irq_* ...
  或 perf 的 max-latency 视图（工具版本差异以本机为准）
  /proc/interrupts 与中断关闭时长配合定位"谁关了多少 us 的锁"
```

## 12.3 RT 类：保"醒来就上"，不保"更快"

`SCHED_FIFO/RR`（0-99 级，`kernel/sched/rt.c`）的真实语义常被误解。它**不提升任何单次运行速度**，只保证两件事：

```text
1 抢占一切 fair：RT 入队，fair 立刻让位
2 不被反向抢占：同 CPU 上 fair 任务无法插队
护栏：全局 RT 带宽 /proc/sys/kernel/sched_rt_runtime_us
  默认 950000/100000 → 所有 RT 任务合计最多占每周期 950ms，
  防止一个失控 RT 循环把系统（含 sshd）饿死
```

误用场景三连：把数据库主线程设 RT（它只是"不想等"，结果饿死所有 kworker/回收）；容器里给业务进程 RT 但宿主没配 `sched_rt_runtime` 余量检查；用 RT 补偿优先级不足的应用锁竞争（锁还在，只是抢得别人没脾气）。

## 12.4 Deadline 类：有合同才算实时

`SCHED_DEADLINE`（`kernel/sched/deadline.c`）比 RT 更进一步——**准入控制**：

```bash
# sched_util 设置：runtime/deadline/period（纳秒）
# 例：每 1ms 周期最多跑 300us，deadline=period
chrt -r 50 ./app   # 这是 FIFO，不是 DL
# 用 sched_attr 系统调用或 SchedUtil/dl 封装设（工具以本机为准）
```

内核把 (300us,1ms) 折算成 0.3 个核的"合同"：能承诺所有 DL 合同的总和不超 CPU 供给才准入（EDF+CBS，带宽耗尽时任务被 throttle 到自己的下一周期）。**合同之外的 CPU 会还给 fair**——所以 DL 组比 RT 组"温和"：它自带了 quota 语义的实时性。

## 12.5 PREEMPT_RT：把实时性做进主线

6.x 时代 `PREEMPT_RT` 已是主线选项（合并于 6.12 系列，此前是 -rt 补丁；具体可用性以发行版内核为准）。核心改造：

```text
spin_lock → rt_mutex（可睡眠，持锁者可被更高优先级抢）
硬中断 → 强制线程化（irq 线程本身是 SCHED_FIFO 1/50）
优先级继承：fair 任务持锁被 RT 等待 → 临时 boost 到 RT 级，
  防止"优先级反转"（中优先级任务插队拖死持锁人）
mmap_lock 等关键路径改造，与内存篇第 3 章的 rwsem 故事汇合
```

代价清单：吞吐下降（锁变睡眠锁）、可调试性变差（时序变了 bug 隐身）、对非实时负载无收益还亏性能。**它的正确定位：有硬实时 SLA（工业控制、电信、音频）才选，通用服务器"感觉卡"不该拿它当药方**——90% 的"该上 RT 内核"案例在 PREEMPT 档 + 正确治理中断/throttling 后自愈（第 9/11/7 章的病先治完）。

**本章要点：**

- 抢占档位决定"最长不可抢占临界区"的上限：NONE→VOLUNTARY→PREEMPT→RT 四档，延迟改善以吞吐下降为价。
- 抢占延迟的实测工具是 cyclictest + tracepoint 归因；怀疑调度前先量化当前内核的尾延迟。
- RT 类只保"醒来就上"，不保变快；`sched_rt_runtime_us` 是防饿死系统的全局护栏，改动前先想清楚谁兜底。
- Deadline 类用准入控制把实时性变成合同：CPU 超卖保护 + 未用带宽还给 fair，比 RT 更可治理。
- PREEMPT_RT 是硬 SLA 场景的最后手段；先治理中断风暴、shootdown、throttling，再谈换内核。

---

# 第 13 章：调度延迟与 off-CPU 分析 - 任务喊冤的"我明明准备好了"

前两章把"谁该跑、怎么抢"讲完，本章处理排障里最容易被忽略的一类证据：任务说"我早就就绪了，为什么没 CPU"。利用率回答的是 CPU 忙不忙，回答不了任务等没等——等待的账要单独查。

## 13.1 把"慢"拆成三段延迟

一次从睡眠到干活的完整旅程有三个可量化的间隔：

```text
sleeping --wake_up--> runnable --pick--> running --block--> ...
             \_Δ1: 入队耗时（waking→wakeup）
                        \_Δ2: 排队耗时（runnable→上 CPU）
调度延迟 = Δ1 + Δ2：任务"准备好了但没摸到 CPU"的时间
Δ2 是绝对主角——Δ1 只在唤醒者/被唤醒者跨 CPU 时才有故事
```

关键区分：业务 P99 里混着三段——CPU 上真跑的时间（run-time）、Δ2 排队时间、以及 off-CPU 阻塞时间（等 IO/锁/定时器）。**"CPU 不高但延迟高"的三种解释**：排队（Δ2 大 → 本章）、阻塞（off-CPU 时间长 → 第 13.4 节）、被限流（throttle → 第 7 章，任务此时不在 runqueue 账里）。不拆开这三段就动手调参数，等于蒙眼开枪。

## 13.2 内核自带的账：/proc/schedstat

内核已经替你记了排队账，白拿：

```text
/proc/[pid]/schedstat    三列：run_time wait_time timeslices
                         单位 ns：累计运行、累计排队、时间片数
/proc/schedstat          per-CPU rq 汇总 + 域统计
                         第二列 wait_time：该 rq 全体任务的排队总和
```

用法账：对单进程 `wait_time / timeslices` = 平均每片排队时长，两次采样做差就是当前窗口均值；对整机，`/proc/schedstat` 的 wait_time 增速和 idle 率背离（idle 还有剩但排队在涨），通常指向**放置不均**而不是总量不足——忙者恒忙、闲者恒闲（第 8 章 wake_affine 的副作用）。注意口径：schedstat 只记 runnable 排队，**不含** cgroup throttle 的等待（throttle 期间任务不进 runqueue），所以"排队账干净但延迟仍高"要回第 7 章查 cpu.stat。

## 13.3 perf sched timehist：逐任务读故事

均值会骗人，P99 不会。要逐任务的延迟分布，用 tracepoint 回放：

```bash
perf sched record -a -- sleep 10
perf sched timehist --show-time -5
```

```text
主要列        含义                     异常信号
delay         Δ2：出队等到的时间       持续 >1ms 即排队病
run-time      本次实际执行时长         极短+高 delay=被打断型
migrations    迁移次数                 高=放置抖动（第 8 章）
wait-max      该任务历史最大排队       尾延迟直接读数
```

读法示范：delay 一列普遍高但 run-time 都短——任务刚上 CPU 就被抢，去查中断（第 9 章）和 RT（第 12 章）；delay 只有个别任务高且 migrations 大——是放置问题，看亲和与 cpuset；delay 呈周期性锯齿——对齐时间轴找 throttle 周期（第 7 章的 period 默认 100ms 就是锯齿源）。

## 13.4 off-CPU 分析：任务在睡着时卡在哪

Δ2 之外的时间都在 off-CPU。按状态分三间"宿舍"：

```text
S  (TASK_INTERRUPTIBLE) 定时睡/等事件
   排查：谁调度的它——perf sched 看 wakeup 调用方；
   应用层：等锁/等响应/主动 sleep，看代码不看内核
D  (TASK_UNINTERRUPTIBLE) 等内核办事
   排查：cat /proc/[pid]/stack 直接读内核栈——
   IO 路径(jbd2/fsync/blk) → IO 篇；回收/compaction → 内存篇；
   mutex/rwsem → 锁竞争，bpftrace 数持锁者
R  但没 CPU             本章 13.2/13.3 的排队账
```

宏观一把抓用 off-CPU 火焰图：采样 sched_switch 的内核栈，把"离开 CPU 时的调用栈"聚合成火焰图，宽度即阻塞时长。它回答的问题和 on-CPU 火焰图互补——后者是"CPU 上时间花在哪"，前者是"没 CPU 的时间里在等谁"。**两者必须配着看**：on-CPU 图说"算术没问题"但业务慢，病灶八成在 off-CPU 图里；反之 D 状态风暴时 on-CPU 的 `sy` 桶会同步虚高（每次阻塞/唤醒都穿内核）。

## 13.5 自己动手测调度延迟分布

现成账不够用（缺尾部分布）时，用 tracepoint 现场量：

```text
# bpftrace：wakeup→下一次切到它的延迟直方图（单位 us）
tracepoint:sched:sched_wakeup { @s[args->pid] = nsec; }
tracepoint:sched:sched_switch {
  if (@s[args->next_pid]) {
    @us = hist((nsec - @s[args->next_pid]) / 1000);
    delete(@s[args->next_pid]);
  }
}
```

口径提醒：这只统计"被唤醒后第一次上 CPU"的延迟；持续运行任务被抢后重新排队的 Δ2 要把 `sched_wakeup` 换成对 `sched_stat_wait` 类统计的读取（字段名以本机内核为准）。判据基线：空载系统调度延迟 P99 应在十 us 级；满载 fair 类正常可容忍 ms 级；**单核上出现百 ms 级就要立案**——不是"忙所以慢"，是排队结构出了问题（RT 插队、throttle、中断风暴都是嫌疑，按第 14 章流程逐个排除）。

## 13.6 三方分诊：谁欠了这笔等待

```text
延迟高 → 先看 throttle？        cpu.stat 增量（第 7 章）
      → 再看排队？             schedstat/timehist（本章）
      → 都不是？看 off-CPU     S/D/R 三间宿舍（13.4）
```

三本账互斥且完备：throttle 期间任务不上 runqueue（schedstat 干净、cpu.stat 涨）；排队期间任务在 runqueue（schedstat 涨、PSI cpu.some 涨——第 15 章交叉验证）；阻塞期间任务不在 runnable（两者都干净、state 是 S/D）。**任何"CPU 慢"的报告，先交出这三张单子再谈调优**。

**本章要点：**

- "CPU 慢"的正确单位是调度延迟（Δ1+Δ2）与 off-CPU 时长，不是利用率；三段时间不拆开，归因必然蒙眼。
- /proc/schedstat 免费提供排队总账，perf sched timehist 提供逐任务明细；均值骗人，wait-max 和直方图不骗。
- off-CPU 按 S/D/R 分诊：D 状态读内核栈定性（IO/锁/回收），S 状态找唤醒源，R 而无 CPU 回到本章排队账。
- throttle、排队、阻塞三本账互斥且完备——交齐三张单子，再决定动哪个旋钮。

---

# 第 14 章：观测工具链与分诊总流程 - 把前十三章走成一棵决策树

工具不是清单，是阶梯：便宜的宏观计数器先缩小嫌疑面，昂贵的微观事件最后定罪。本章把全书的观测手段串成一条流水线。

## 14.1 四层工具阶梯

```text
第一层 计数器     free/vmstat/sar/uptime     趋势与立案，零开销
第二层 进程账     top/pidstat//proc/[pid]/*  嫌疑人画像，低成本
第三层 内核事件   perf/ftrace/tracepoint     行为取证，开销 1-10%
第四层 可编程     bpftrace/eBPF 工具集       定制问题，按需部署
```

纪律：第一层回答"有多少"，永远不回答"为什么"；到了第三层才允许出现因果句。跳级用（空载直接挂 perf 追全系统）等于用显微镜找丢的钥匙——先站在门口看看地上有没有（计数器）。

## 14.2 现象-工具主表

| 现象 | 首选工具 | 下一步指向 |
| --- | --- | --- |
| load 高 CPU 不高 | vmstat 的 r 与 procs_blocked | 第 13.4 节分 S/D |
| 周期 P99 毛刺 | cgroup cpu.stat 增量 | 第 7 章 throttle |
| sy 高 | perf top 内核符号 | 第 11 章 shootdown/系统调用 |
| si 高 | /proc/softirqs 两采样差分 | 第 9 章网络 RX 集中度 |
| wa 高 | off-CPU 图 + iostat 延迟列 | IO 篇分诊树 |
| 切换数暴涨 | pidstat -w 主动/被动比 | 第 4 章分诊刀 |
| 单核忙整体闲 | /proc/schedstat per-rq | 第 8 章放置/亲和 |
| 尾延迟无规律 | 13.5 直方图测分布 | 第 12 章 cyclictest 对照 |

## 14.3 五步分诊流程

```text
立案    r vs nproc + PSI 三文件 + steal        （第 2 章）
定性    user/sys/irq/steal 四桶判忙/等/限/偷    （第 2/10 章）
分路    voluntary vs nonvol 对照 cpu.stat       （第 4/7 章）
定罪    perf/bpftrace 栈级锁定函数+cgroup       （第 11-15 章）
处置    对症调整 + 快照集复核                   （第 14.4 节）
```

要点：第 1 步**永远先判"忙/等/限/偷"四态**（计算饱和、IO 阻塞、限流、虚拟化 steal），四态处方互不相通——给 throttle 的病开"加核"药，给 steal 的病开"调调度参数"药，都是本流程要拦截的错误。第 4 步定罪必须落到**具体函数/具体调用栈/具体 cgroup**三者之一，否则退回取证。

## 14.4 生产环境最小快照集

故障现场只有 90 秒时按此清单打包（全部只读、秒级）：

```bash
uptime; vmstat 1 5; pidstat -u -w 1 3
mpstat -P ALL 1 3
cat /proc/pressure/cpu; cat /proc/pressure/io
cat /proc/schedstat; grep -r nr_throttled /sys/fs/cgroup
perf top -a            # 或 perf record -a 30s 事后分析
cat /proc/softirqs     # 隔 5s 两次，看差分
dmesg | tail -50       # 抢占/RCU stall/throttle 内核自白
```

内核的三份"自白书"经常被跳过却信息密度最高：`dmesg`（rcu_sched stall、soft lockup、throttled 都有主动播报）、`/proc/pressure/*`（谁在 stalled）、`/proc/interrupts` 增量（哪路 IRQ 在风暴）。

## 14.5 五个观测陷阱

1. **`%idle` 含 iowait**：wa 40% + idle 50% 的系统既"空闲"又"堵死"，r 列和 PSI 才是真相（第 2 章）。
2. **均值藏尾**：cpu.stat 的 average throttled time 好看，P99 已炸——看 max 和分布（第 7 章）。
3. **容器基线错**：`nproc` 在容器里可能报宿主核数，r/nproc 的比值全盘失效——进 cgroup 读 quota 换算（第 7 章）。
4. **steal 找错医生**：steal 高时在 guest 里调调度器无效，账在宿主 hypervisor（第 10 章虚拟化部分）。
5. **采样即扰动**：perf record -g 全系统 30 秒在高频切换场景本身能吃掉数个核——先小范围（-C、-p）再扩大，快照集里 perf top 优先于 record。

**本章要点：**

- 工具是阶梯不是清单：计数器立案、进程账画像、内核事件定罪、eBPF 定制；跳级等于蒙眼开枪。
- 五步流程的骨头：先判忙/等/限/偷四态，再做主动/被动分诊，定罪必须落到函数/栈/cgroup 粒度。
- 最小快照集十秒打完，dmesg、PSI、中断增量三份内核自白书不许跳过。
- 五个陷阱各毁一次误诊：iowait 记账、均值藏尾、容器基线、steal 归属、采样扰动。

---

# 第 15 章：PSI 压力失速信息 - 内核直接汇报"谁在 stalled"

第 5.4 节欠下的账在此结清：PELT 回答"占了多少"，PSI 回答"等得有多难受"。它是全书观测线的收口——loadavg 和 %util 犯过的 extrapolation 错误，PSI 从定义上就不犯：它数的就是 stalled 时间本身。

## 15.1 loadavg 与 %util 都够不到的地方

loadavg 是指数衰减的 runnable 计数，告诉你"有任务在排队"，不告诉你排了多久、谁在排；%util 是设备忙时间占比，NVMe 多队列下彻底失真（IO 篇细讲）。两者共同的缺陷：**都不直接度量"等待的痛"**。PSI（Pressure Stall Information，4.20 引入，Kernelsource `kernel/sched/psi.c`）补的就是这一层：按资源类别累计 stalled 微秒数，不衰减、不推算、不掺水。

## 15.2 记账模型：some/full × cpu/mem/io

```text
/proc/pressure/cpu    /proc/pressure/io    /proc/pressure/memory
每个文件两行：
  some  avg10=.. avg60=.. avg300=.. total=<us>
  full  avg10=.. avg60=.. avg300=.. total=<us>
some：至少有一个任务在等资源（有人等）
full：所有任务都在等资源（全停在 stall 点，系统级停摆）
avg10/60/300：10/60/300s 窗口的 stalled 时间占比（%）
total：自启动累计 stalled us——做差分，别读绝对值
```

cpu 口径的 stalled 定义：任务 runnable 但未拿到 CPU（有的任务 Sleeping 但不等 CPU 不算进 some 分母；细节语义以 `kernel/sched/psi.c` 注释为准）。io 口径：任务阻塞在未完成的 IO 上。mem 口径：阻塞在内存回收/缺页上——**三类压力分别记账，互不串账**，这是 PSI 比单个 loadavg 强的根本原因：load 把 IO 等待和 CPU 排队混进一个数。

## 15.3 cpu 压力：哪段等待会被记进账

```text
cpu.some 上涨的三种病因：
  1 总量过订阅：r > nproc 持续（第 2 章），排队即 stalled
  2 放置不均：单 rq 排长队而整机有 idle（第 8 章）
  3 抢占挤压：RT/中断把 fair 压成排队流（第 9/12 章）
cpu.full 的苛刻条件：
  所有非睡眠任务都 stalled 在 cpu 资源上——
  典型只在"任务被 throttle 且无 idle CPU 可捡"或
  极端单 CPU 过订阅时出现
```

与前面章节的账目对齐：第 7 章 throttle 期间 cgroup 任务不进 runqueue，**系统级 cpu.some 不涨**，但该 cgroup 的 `cpu.pressure` 涨（15.6）——"整机 PSI 干净、业务仍卡"的容器场景，两本 PSI 账要分开看。steal 的归属：被 hypervisor 偷走的时间在 guest 内**既不算 running 也不算 runnable stalled**（定义争议存在，以本机实测为准），所以虚拟化环境 PSI 偏低是常态，别拿它当"没压力"的证据。

## 15.4 轮询与触发：压力文件是可以 poll 的

PSI 不只是读数，还是**事件源**：

```bash
# inotify 不行；CLI 触发器（工具名以本机为准，如 psi-trigger）
# 语义：cpu some 连续 500ms 超过 25% 时返回
cat pressure --trigger some cpu 25 500
```

poll 返回后读 total 差分即知涨了多少。这是 K8s 压力驱逐、systemd-oomd、自愈脚本的正确原语——**阈值+持续时间**一起给，单点阈值必被毛刺骗（第 14.5 节均值陷阱的镜像问题：瞬时值同样不可信）。对比 loadavg 告警的迟钝（指数衰减拖尾 5 分钟级），PSI 触发是秒级、资源分维的。

## 15.5 CPU 过订阅的复现实验

```bash
# 4 核机起 6 个 busy loop，30s 后撤走，观察三段
watch -n 1 cat /proc/pressure/cpu   # 另开终端
# 预期：some.avg10 从 0 → 40-60%；loadavg 同步涨
# 撤走后：PSI avg 快速回落，loadavg 拖尾——这就是两者的性格差异
```

反向实验更要做：**CPU-bound 打满不等于 cpu.full 高**——满载但人人都在跑时，some 会涨（总有瞬时 runnable 多于核数），full 几乎不动（没有人"全员 stalled"）。误把 full 当 CPU 压力主指标会漏诊；**some 是 CPU 压力的主力读数，full 主要用于 mem/io 的系统级停摆判据**（内存篇已见过 memory.full 的 OOM 前兆用法）。

## 15.6 每 cgroup 的 cpu.pressure 与编排联动

cgroup v2 在每个控制组下挂 `cpu.pressure`（格式同全局文件）：`/sys/fs/cgroup/<path>/cpu.pressure`。K8s 视角的三本账对照：

```text
container cpu throttled    cgroup cpu.stat      被 quota 罚站（第 7 章）
cgroup cpu.pressure some   cgroup cpu.pressure  等不到 CPU（排队/挤压）
system /proc/pressure/cpu  全局                 整机是否过订阅
```

驱逐/告警规则的正确写法：以 cgroup 级 some 为主（业务归属清晰），system 级为辅（避免全局故障误杀个体），throttled 单独成规则（它是"被自己配额杀"，处方是扩配额不是换节点——第 7.5 决策表）。

**本章要点：**

- PSI 直接度量 stalled 时间：不衰减（区别于 loadavg）、不推算（区别于 %util）、分资源记账（区别于一切混合指标）。
- cpu.some 是 CPU 压力主力读数；cpu.full 条件苛刻，等 full 报警会系统性漏诊——这是最常被误读的口径。
- throttle 不进全局 cpu.some 但进 cgroup cpu.pressure——容器场景必须两本 PSI 账分开核对。
- PSI 的正确用法是 poll 触发（阈值+时长），K8s 驱逐/自愈脚本应建立在 cgroup 级 cpu.pressure 上而非 loadavg。

---

# 第 16 章：五个完整案例 - 从现象到根因的 RCA 闭环

前十五章的零件在此组装。五个案例都走同一条流水线：量化→分诊→定罪→处置→回归验证，没有一例从"调参数"开始。

## 16.1 案例一：周期性 P99 毛刺（throttle 真空泡）

**现象**：Java 服务 P99 每 100ms 出现一次 80ms 尖峰，CPU 利用率"看起来"只有配额的 60%。**取证**：`cpu.stat` 差分 `nr_throttled` 每周期 +1、`throttled_usec` 合计与毛刺面积吻合；`/proc/schedstat` 干净（排除排队病）；`perf sched timehist` 显示毛刺时刻整组任务 delay 同步清零——它们全在 throttle 名单里。**定罪**：默认 100ms period 下 80ms 的突发计算撞 quota 上限（第 7 章真空泡机制）；利用率均值健康掩盖了并行峰值瞬时打爆。**处置**：`cpu.max` period 从 100ms 缩到 20ms，毛刺变矮变密、P99 从 80ms 落到 9ms；总量仍不足才提配额。**回归**：压测 30 分钟，throttled 增率为零。

## 16.2 案例二：si 高吞吐低（softirq 单队列）

**现象**：网关 `mpstat` si 40%，网卡标称 10G 实际吞吐 2G。**取证**：`/proc/softirqs` 差分显示 NET_RX 90% 落在 cpu0；`/proc/interrupts` 同向——eth-TxRx-0 一路 IRQ 风暴。**定罪**：网卡默认单队列中断，全部收包 softirq 压在 boot CPU（第 9 章）。**处置**：开多队列（ethtool -L combined 8）+ 中断亲和打散；RSS 不均衡再加 RFS 跟随应用线程。**回归**：si 峰值降到单核 30%，吞吐 7.8G。**教训**：si 桶的问题从来不在"CPU 总账"，在"分布"——第 14 章快照集里 mpstat -P ALL 和 softirqs 差分缺一不可。

## 16.3 案例三：load 30 而 CPU 20%（D 状态堆积）

**现象**：告警 load 30，`top` 显示 idle 78%。**取证**：`vmstat` procs_blocked=25；`ps -eo stat,pid,comm` 一片 D；抽三个 D 任务 `cat /proc/[pid]/stack`，栈顶全是 jbd2 相关——fsync 在等日志提交（内存篇/IO 篇的账）。**定罪**：ext4 日志屏障被慢盘拖住，提交路径 D 状态串行——load 计的是"排队+不可中断"，与 CPU 无关（第 2 章定义在此兑现）。**处置**：短期把高频小 fsync 改为批量 sync_file_range；中期换 NVMe 并评估屏障语义（IO 篇第 5 章细讲）。**回归**：D 峰值从 25 降到 2，load 与 CPU 利用率重新成比例。

## 16.4 案例四：整机 sy 抖，干活的只有一个（shootdown 风暴）

**现象**：8 核机 sy 常年 30%，perf top 头部 `native_queued_spin_lock_slowpath` 与 TLB 相关符号。**取证**：`perf stat -e tlb:tlb_flush` 每秒数万次；采样周期内 shootdown 目标 CPU 分散、发起者集中在一个进程的 munmap 批处理（第 11 章画像）。**定罪**：jemalloc decay 激进 + 大块 mmap/munmap 风暴 → IPI broadcast flush 把全核拖进内核陪跑。**处置**：调 `dirty_decay_ms`/`muzzy_decay_ms` 拉长保留、或换 arena 复用；**没有加一个核**。**回归**：sy 降到 4%，业务吞吐 +11%——治 shootdown 的收益从不在被偷的核上，在不用陪跑的核上。

## 16.5 案例五：隔离核仍抖（三层漏网之鱼）

**现象**：低延迟交易机已配 isolcpus+nohz_full，cyclictest 尾延迟仍偶发 500us。**取证**：`ps -e -o psr,comm` 发现 cpu6 上漂着 2 个内核线程；`/proc/interrupts` 有 timer 残留；turbostat 显示退出 C6 耗时与尾延迟同源（第 10 章）。**处置三连**：rcu_nocbs 补上 RCU 层 + 线程 cpuset 钉走（第 8 章三板斧缺一层就漏）；IRQ 亲和清零；governor 改 performance + 关深层 C-state（第 10 章暗账）。**回归**：尾延迟 500us → 90us。**教训**：隔离不是开一个内核参数，是把"谁会踩进你的核"逐个点名——中断、RCU、内核线程、频率、C-state 五本账。

## 16.6 收尾：全书地图

```text
三本账贯穿全书：
  公平账  vruntime/lag/slice      第 3/6 章 —— 谁该跑
  带宽账  quota/cpuset/权重       第 7/8 章 —— 能跑多少
  延迟账  Δ1+Δ2/throttle/PSI     第 13/15 章 —— 等了多久
分诊主线（第 2 章树的完整版）：
  立案: r vs nproc + PSI 三文件 + steal
  定性: 忙/等/限/偷 四态
  定罪: 切换刀(4章) → 排队账(13章) → 频率/中断暗账(9/10/11章)
  处置: 决策表(7.5) + 快照集(14.4) + 回归验证(本章)
```

**本章要点：**

- 五个案例同一条流水线：量化→分诊→定罪→处置→回归；没有一例的根因是"调度器不行"，全是配额、放置、中断、映射、隔离的具体决策债。
- 周期毛刺对齐 throttle period、si 高看分布不看总量、load 与 CPU 背离查 D 栈、sy 虚高找 shootdown 发起者、隔离抖动数三层漏网。
- 全书三本账：公平（谁该跑）、带宽（能跑多少）、延迟（等了多久）——排障时先问欠了哪本账。
- CPU 篇与 IO 篇、内存篇在 fsync、回收、PSI、缺页四处握手；带着本篇的分诊树去 IO 篇，很多线索已经预热。

---
