---
title: Java 11 应用进程内存地址生命周期管理：从 execve 到 exit_mm 的完整工作原理
date: 2026-10-01 10:00:00
categories: [操作系统]
tags: [Linux, 内核, 内存, JVM, Java, 性能优化]
---

> 本文把 Linux 进程的虚拟地址空间当作一种**有状态、有生命周期的资源**来讲：它如何诞生、如何被开辟、如何在一页一页的缺页中被"点火"、如何在 `mprotect` / `madvise` 之间迁移状态、又如何在 `exit_mm` 中被逐层拆解归还。Java 11 HotSpot 是贯穿全文的实证样本——内核里的每一段机制，最终都能在 `java -Xmx8g` 进程的 `/proc/<pid>/maps` 里找到对应的那一行。

# 第 1 章：引言 - 把地址空间当作有生命的资源

## 1.1 一条时间轴：从 `java -jar app.jar` 到进程退出

大多数内存故障排查之所以低效，是因为工程师把"内存"当成一个**静态的总量**来看：`top` 里那一列 `RES`，像是一个水位。但内核不是这么工作的。内核维护的是一串**有出生、有状态迁移、有死亡**的对象。当我们敲下 `java -jar app.jar`，这个进程的地址空间在几毫秒到几十分钟之间，完整地走过了六个阶段：

```text
   ①诞生        ②开辟          ③提交            ④迁移
     │            │              │                │
     ▼            ▼              ▼                ▼
 ┌────────┐  ┌─────────┐  ┌─────────────┐  ┌──────────────┐
 │ execve │→ │mmap/brk │→ │ 首次读写    │→ │ mprotect     │
 │        │  │         │  │ (page fault)│  │ madvise      │
 └────────┘  └─────────┘  └─────────────┘  └──────┬───────┘
                                                   │
 ┌────────┐  ┌─────────┐  ┌─────────────┐         │
 │exit_mm │← │ munmap  │← │DONTNEED     │←────────┘
 │        │  │         │  │ (页表清空)  │
 └────────┘  └─────────┘  └─────────────┘
   ⑥销毁        ⑤退场          ⑤'退场不消失
```

六个阶段各自的**内核动作**与**可观测后果**如下：

| 阶段 | 触发点 | 内核主要函数 | 数据结构后果 | 观测指标变化 |
|---|---|---|---|---|
| ① 诞生 | `execve("/bin/java")` | `bprm_mm_init` → `load_elf_binary` | 新建 `mm_struct`，插入首批 VMA | `VmSize` 从 0 跳到约 40MB |
| ② 开辟 | `mmap(PROT_NONE, 8G)` | `do_mmap` → `mmap_region` | 插入一个大 VMA，页表为空 | `VmSize` ↑，`VmRSS` 不变 |
| ③ 提交 | 第一次读写该区域 | `handle_mm_fault` → `alloc_pages` | 建立 PTE，物理页归属该进程 | `VmRSS`、`AnonPages` ↑ |
| ④ 迁移 | `mprotect` / `madvise` | `do_mprotect_pkey` / `madvise_dontneed` | VMA 权限或提示位变化 | `VmFlags` 变化，RSS 可能不变 |
| ⑤ 退场 | `madvise(MADV_DONTNEED)` | `zap_page_range` | PTE 清空但 VMA 保留 | RSS ↓，`VmSize` 不变 |
| ⑥ 销毁 | `exit_group` / `munmap` | `exit_mm` → `exit_mmap` | VMA、页表、`mm_struct` 全释放 | 全部归零 |

用 `strace` 抓一段 Java 启动过程，这条时间轴是肉眼可见的：

```bash
strace -f -e trace=execve,mmap,brk,mprotect,madvise,munmap \
       -o java-start.log java -Xms8g -Xmx8g -jar app.jar
```

```text
[pid 20481] execve("/usr/lib/jvm/java-11/bin/java", ["java", "-Xms8g", ...]) = 0
[pid 20481] mmap(NULL, 8323224, PROT_READ, MAP_PRIVATE, 3<...>, 0) = 0x7f2c6c000000
[pid 20481] brk(0x55d3ab200000)          = 0x55d3ab200000
[pid 20481] mmap(NULL, 134217728, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0) = 0x7f2bb0000000
[pid 20481] munmap(0x7f2bc0000000, 69206016) = 0
[pid 20481] mprotect(0x7f2bb0000000, 13565952, PROT_READ|PROT_WRITE) = 0
[pid 20481] mmap(NULL, 8589934592, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0) = 0x7f2a80000000
[pid 20481] mprotect(0x7f2a80000000, 8589934592, PROT_READ|PROT_WRITE) = 0
```

第 7 行的 `mmap(NULL, 8589934592, PROT_NONE, ...)` 就是阶段②"开辟"——8GB 堆的虚拟地址在这里被一次性圈占，但**一个物理页都没有分配**。紧接的 `mprotect` 把它变成可读写，即 JVM 语义里的 commit；而真正的物理页，要等 GC 线程第一次往 Region 里写对象时才通过阶段③的缺页产生。中间那组 `mmap(128MB, PROT_NONE) → munmap → mprotect` 则是 glibc 的 `new_heap()` 在为一个 malloc arena 圈地（第 6 章和第 12 章案例 3 会再遇到它）——同一个"先预留、再收缩、后放开保护"的三步式，走的是完全相同的 `do_mmap` 内核路径。

> **关键认知**：`mmap` 只是**买地皮**，`page fault` 才是**盖房子**，`madvise(MADV_DONTNEED)` 是**拆房但留着地皮**，`munmap` 才是**退租**。把这四个动作用词区分开，90% 的"内存没释放"争论会自动消失。

## 1.2 "开辟内存地址空间"的三层含义

"开辟"这个词在中文技术讨论里同时指代了三件完全不同的事，它们分别由内核的三个不同结构记账：

```text
┌───────────────────────────────────────────────────────────────┐
│ L1 Reserved  预留：地址区间被登记在 mm 的 VMA 树上              │
│   内核账本：mm->total_vm    用户可见：VmSize / VmPeak / VSZ     │
│   ┌─────────────────────────────────────────────────────┐     │
│   │ L2 Committed  提交：内核承诺"缺页时能给你物理页"      │     │
│   │   内核账本：Committed_AS   用户可见：VmData + 记账    │     │
│   │   ┌───────────────────────────────────────────┐     │     │
│   │   │ L3 Resident  驻留：真正占用物理内存的页     │     │     │
│   │   │   内核账本：页表 PTE 有效   用户可见：VmRSS  │     │     │
│   │   │   ┌─────────────────────────────┐          │     │     │
│   │   │   │ L4 Used 使用：JVM 内部计数   │          │     │     │
│   │   │   │  Heap.used / Metaspace.used │          │     │     │
│   │   │   └─────────────────────────────┘          │     │     │
│   │   └───────────────────────────────────────────┘     │     │
│   └─────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────┘
```

这四层在 Java 进程上会呈现非常夸张的漏斗形状。取一个真实场景：`-Xms8g -Xmx8g`、G1、约 300 线程、堆里存活对象约 5g、已完成三次 Full GC 前的稳态运行 40 分钟：

```bash
PID=$(pgrep -f 'app.jar' | head -1)
grep -E 'VmPeak|VmSize|VmRSS|VmData|RssAnon|RssFile|VmPTE|Threads' /proc/$PID/status
```

```text
VmPeak: 21745388 kB
VmSize: 21743120 kB     ← L1 预留：约 20.7 GB
VmRSS :  9134588 kB     ← L3 驻留：约 8.7 GB
RssAnon: 8902164 kB     ← 匿名页（堆 + 线程栈触碰部分 + Metaspace）
RssFile : 232424 kB     ← file-backed（jar、.so、只读数据段）
VmData : 12024816 kB    ← L2 提交的近似视图（数据段+堆，不含代码段）
VmPTE  :   18136 kB     ← 页表本身的开销
Threads:  312
```

对应关系一目了然：`VmSize` 的 20.7GB 里只有 8.7GB 真正压在物理内存上，剩下 12GB 只是一段 `PROT_NONE` 的地址登记。而 JVM 自己认为的"已使用"（`jcmd GC.heap_info`）只有 5.2GB——比 RSS 还少 3.5GB，差额是线程栈、Metaspace、CodeCache、glibc arena 和 Direct Buffer。

> **关键认知**：四层中任何一层单独拿出来都不能回答"这个进程用了多少内存"。告警要用 `VmRSS`/`PSS`，容量规划要用 `VmData` 的增速，排查泄漏要同时看 `Used` 与 `Committed`，判断预留是否过大要看 `VmSize`。

## 1.3 为什么 `-Xmx8g` 的进程 VSZ 会有 20GB+

上面那 20.7GB 的 `VmSize` 是怎么凑出来的？拆开看，`-Xmx8g` 只贡献其中一部分：

| 组成 | 大小 | 建立方式 | 是否计入 Committed |
|---|---|---|---|
| Java 堆预留 | 8.0 GB | `mmap(PROT_NONE, MAP_NORESERVE)` | 部分（随 Region commit 增长） |
| Metaspace 预留 | ~1.0 GB | `VirtualSpace` 分段预留，chunk 粒度 commit | 是，随类加载增长 |
| CodeCache | 240 MB | 三段 `SegmentedCodeCache`，先预留后 commit | 是 |
| 312 线程栈 | ~325 MB | `pthread` → `mmap` `-Xss 1m` + guard page | 仅触碰部分 |
| glibc malloc arena | ~6 GB | 8 核 × 8 arena × 64MB 预留的 arena heap 段 | 视分配而定 |
| 共享库映射 | ~180 MB | `ld.so` 的 `PROT_READ` file-backed | 不计（`MAP_NORESERVE` 语义） |
| 其余小块 | ~200 MB | `libjli`、`hsperfdata`、JNA、Netty 段 | 混合 |

真正让 VSZ 显得"虚高"的是前两行与 arena 预留。HotSpot 的 `os::reserve_memory()` 在 Linux 上等价于一次不带 `MAP_FIXED` 的 `mmap(NULL, size, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0)`——注意 `PROT_NONE`：这段地址即使被 VMA 登记，任何访问都会立刻 `SEGV_ACCERR`，所以它只是**占号**，既不写页表也不提交记账。

这正是本文要讲的核心机制：**地址空间的开辟（VMA 插入）与内存的提交（物理页分配）在内核里是两个被彻底解耦的动作**。理解了这一点，才能理解为什么"进程 VSZ 很大"和"进程快 OOM 了"是两件毫不相干的事，也才能理解为什么 `MADV_DONTNEED` 之后 RSS 降了但 `VmSize` 一点没动。

第 4 章会完整拆解 `do_mmap` 的实现，第 8 章会给出 HotSpot `VirtualSpace` ↔ 内核 VMA 的逐项对照。

## 1.4 本文与系列另外三篇的分工

本文属于同一个四篇系列，写作前请先确认你要找的内容属于哪一篇：

| 文章 | 主线 | 你会在里面找到 | 你不会在里面找到 |
|---|---|---|---|
| 《系统内核基础结构分析》 | 内核整体结构 | 页表/伙伴系统/slab 的**入门科普**、调度、VFS、网络栈 | VMA 插入路径、缺页分支树、`exit_mm` 细节 |
| 《系统内存分配应用分析》 | **分配器**视角 | ptmalloc2 的 chunk/arena/tcache、各语言运行时分配策略、cgroup 计费 | `mm_struct` 生命周期、VMA 状态迁移、`munmap` 成本 |
| 《Java11 虚拟机系统配置指南》 | **JVM 参数**视角 | `-Xmx/-Xms` 设置、G1 调优、GC 日志、jcmd/jmap 工具链、容器配置 | 参数背后的内核动作、缺页代价、页表元数据 |
| **本文** | **地址空间生命周期**视角 | 诞生→开辟→提交→迁移→退场→销毁的完整内核路径，并逐段映射到 Java 11 行为 | 分配器内部结构（一句话引用上一篇）、GC 算法细节 |

三句话概括差异：分配器讲"一块内存怎么切"，JVM 配置讲"参数怎么设"，本文讲**"一段地址从被登记到被销毁，内核为它做了什么、又什么时候才真的放手"**。

## 1.5 读者、前置知识与阅读地图

本文面向已经写过 Java 后端服务、做过容器化部署、知道 `/proc` 存在的工程师与 SRE。前置知识只需要两点：

1. 知道进程有虚拟地址空间、页表把虚拟地址翻译成物理地址（不记得没关系，第 2 章补齐）；
2. 用过 `top` / `ps` / `jcmd` 中的任意一种，会读 `/proc/<pid>/maps` 的一行输出。

内核版本口径统一为 **Linux 5.10 / 5.15 / 6.6 三个 LTS**，凡是能力有版本分界的地方都会就地标注（例如 Maple Tree 是 6.1 分界，`MADV_POPULATE` 是 5.14）；JVM 口径统一为 **OpenJDK 11.0.x HotSpot**。

全文十五章按生命周期阶段分组：

```text
第 2 章 数据结构底座 ──────────────────────────┐
                                               │ 认识账本
第 3 章 诞生（fork/execve/ELF 装载）           │
第 4 章 开辟（mmap / brk / overcommit 记账）   │ 建立地址
第 5 章 提交（缺页异常与按需分页）             │
第 6 章 提交的落地层（物理页与页表元数据）     │ 占用物理
第 7 章 状态迁移（mprotect / madvise / mremap）│ 改变状态
第 8 章 JVM 视角的开辟-提交-归还闭环 ★特色章   │ 实证样本
第 9 章 迁移与共享（fork COW / MAP_SHARED）    │
第 10 章 终点（munmap / exit_mm / 回收）       │ 拆解归还
──────────────────────────────────────────────┼ 方法论
第 11 章 可观测性（maps 时序 / eBPF / 端到端）  │
第 12 章 企业故障案例 ×6                        │ 会用
第 13 章 调优方法论                             │
第 14 章 与其他运行时的横向对比                 │ 会判断
第 15 章 总结与学习路径                         │
```

**本章要点：**

- 地址空间是**有生命周期的资源**，六个阶段分别是诞生、开辟、提交、迁移、退场、销毁，各由不同的内核函数与不同的账本承载
- "开辟内存"在中文里混指 Reserved（`total_vm`）、Committed（`Committed_AS`/`VmData`）、Resident（`VmRSS`）三层，加上 JVM 自己的 Used 共四层，任何单层都不能回答"用了多少内存"
- `-Xmx8g` 的进程 VSZ 到 20GB+ 是正常现象：`mmap(PROT_NONE|MAP_NORESERVE)` 只登记地址、不建页表、不提交记账
- `mmap` 是买地皮，`page fault` 是盖房子，`MADV_DONTNEED` 是拆房留地皮，`munmap` 是退租
- 本文主线是**生命周期**，与系列另外三篇（分配器 / JVM 参数 / 内核科普）严格分工不重复

---

# 第 2 章：数据结构底座 - mm_struct、VMA 与页表

要讲生命周期，先得讲清楚"活着的是什么东西"。Linux 里一个进程的地址空间由三层结构支撑：`mm_struct` 是总账本，`vm_area_struct`（VMA）是一段地址的出生证明，页表是地址到物理页的实际映射关系。本章逐项拆解这三层，并给出它们与用户态可见字段（`/proc/pid/*`）的对应关系。

## 2.1 `mm_struct`：一份地址空间的总账本

定义在 `include/linux/mm_types.h`。它是生命周期所有阶段的"当事人"——诞生时它被 `mm_alloc()` 创建，销毁时它被 `free()` 回 slab。生产内核版本不同字段会增减，以下列出与本文强相关的部分：

| 字段 | 类型 | 含义 | 用户态对应 |
|---|---|---|---|
| `mm_mt` / `mmap` | `struct maple_tree` / `vm_area_struct*` | VMA 的组织结构：6.1+ 是 Maple Tree，旧版本是 rbtree + 链表 | `/proc/pid/maps` 的行集合 |
| `pgd` | `pgd_t*` | 页表根（第四级 PGD 页） | `VmPTE`、`VmPgD` |
| `mmap_lock` | `rw_semaphore` | 保护整棵树的最大锁（旧名 `mmap_sem`，5.8 改名） | 决定 `fork`/`exit` 阻塞时长 |
| `context` + `cpu_bitmap` / `cpu_file` | `mm_context_t` | **TLB 世代号**：每次地址翻译变化递增，用于精准 TLB flush | 解释 `munmap` 的 IPI 成本 |
| `start_code`/`end_code`、`start_data`/`end_data` | `unsigned long` | ELF 段边界 | `VmExe`、`VmData` 的一部分 |
| `start_brk` / `brk` | `unsigned long` | 堆的静态起点与当前指针 | `pmap` 中 `[heap]` 行的起止 |
| `start_stack` | `unsigned long` | 初始栈顶 | `[stack]` |
| `arg_start`/`arg_end`、`env_start`/`env_end` | `unsigned long` | argv/envp 在栈上的位置 | `cat /proc/pid/cmdline` |
| `total_vm` | `unsigned long`（页） | 所有 VMA 覆盖的页数总和 | `VmSize` = `total_vm × 4` kB |
| `reserved_vm` | 同上 | 历史上给 `MAP_GROWSDOWN` 预留记账用，现代内核基本只做占位 | 无直接字段 |
| `locked_vm` | 同上 | `mlock` 锁住的页数 | `VmLck` |
| `pinned_vm` | `atomic64_t` | `get_user_pages` 钉住的页数（RDMA/`io_uring`） | `VmPin` |
| `map_count` | `int` | 当前 VMA 条数 | 与 `vm.max_map_count` 比较的判据 |
| `def_flags` | `unsigned long` | 后续新增 VMA 的默认位（如栈的自动增长相关） | 无 |
| `write_protect_seq` | `seqlock_t` | 与 `userfaultfd` + `fork` 交互的写保护序号 | 无 |
| `owner` | `task_struct*` | 当前"拥有"该 mm 的线程，退出路径用于判断能否异步释放 | `exit_mm` 的 `mmput` 分支 |
| `mm_cpumask` | per-CPU 掩码 | 该 mm 的 TLB 可能出现在哪些 CPU 上，决定 shootdown 广播范围 | `munmap` 慢的根因 |
| `hi_water_rss`、`rss_stat` | `mm_rss_stat` | RSS 的分项计数（file/anon） | `RssFile`、`RssAnon` |

字段与 `/proc/pid/status` 的换算关系可以直接用一行命令验证：

```bash
getconf PAGE_SIZE
grep VmSize /proc/$PID/status
```

```text
4096
VmSize:   21743120 kB
```

`VmSize` 除以页大小：21743120 kB ÷ 4 kB = **5435780 页**，这个数字应当与 `/proc/pid/statm` 的**第 1 字段**（size，以页为单位）一致：

```bash
cat /proc/$PID/statm
```

```text
5435780 2283647 31204 1 0 2987102 0
        │       │     │ │  │
        │       │     │ │  └─ data+stack 页数（≈ VmData/4）
        │       │     │ └─── 共享页（此处常为 0，历史遗留字段）
        │       │     └───── text 页数
        │       └─────────── resident 页数（× 4 kB ≈ VmRSS）
        └─────────────────── size 页数（= mm->total_vm）
```

> **关键认知**：`statm` 的第二个数字是 `mm->rss_stat` 的快照，第一个是 `total_vm`。这两个数字的比值就是"预留到驻留"的转化率，是判断一个 JVM 是否在虚耗地址空间的最快指标——正常的大堆 Java 服务在 0.3~0.5 之间，纯预留型（`-Xmx` 远大于实际用）会低于 0.2。

## 2.2 `vm_area_struct`：一段地址的出生证明

VMA 是生命周期里**状态迁移的最小单位**。内核不知道"Java 堆"是什么，它只知道 `0x7f2a80000000-0x7f2c80000000` 这段 `rw-p` 的 VMA。

```c
/* include/linux/mm_types.h（要点摘录，字段随版本演进） */
struct vm_area_struct {
    union {
        struct {
            unsigned long vm_start;   /* 含 */
            unsigned long vm_end;     /* 不含：区间 [vm_start, vm_end) */
        };
#ifdef CONFIG_MAPLE_TREE
        /* 6.1+ 部分内核把起止放进 MAPI state */
#endif
    };
    struct mm_struct  *vm_mm;         /* 反向指针：属于哪个地址空间 */
    pgprot_t           vm_page_prot;  /* PTE 的实际保护位 */
    unsigned long      vm_flags;      /* VM_READ|VM_WRITE|... 语义位 */
    loff_t             vm_pgoff;      /* file-backed 时的页偏移 */
    struct file       *vm_file;       /* 映射的文件（匿名时可为 NULL） */
    void              *vm_private_data;
    const struct vm_operations_struct *vm_ops; /* file-backed 的 fault 回调 */
    struct anon_vma   *anon_vma;      /* 反向映射的锚点，见 6.5 节 */
    struct rb_node     rb;            /* 旧版本：rbtree 节点 */
    struct vm_area_struct *vm_next, *vm_prev;  /* 旧版本：按地址有序链表 */
};
```

`/proc/pid/maps` 每行的权限列（如 `rw-p`）是 `vm_flags` 与 `vm_page_prot` 的四种可读字符化结果：

| 字符 | 含义 | 对应位 | 若为 `-` 的后果 |
|---|---|---|---|
| `r` | 可读 | `VM_READ` → `PAGE_PRESENT` 之外加 `_PAGE_USER` 且非 ro-protect | 读触发 `SEGV_ACCERR` |
| `w` | 可写 | `VM_WRITE` → PTE `_PAGE_RW` | 写触发 `SEGV_ACCERR`（不是 `SEGV_MAPERR`） |
| `x` | 可执行 | `VM_EXEC` → `_PAGE_NX` 清零 | 取指触发保护错误；JIT 段的 `mprotect` 就是改这一位 |
| `p` / `s` | 私有 / 共享 | `VM_SHARED`（`s`）或未置位（`p`） | 决定写时是否 COW，也决定页是否进 page cache |

`VM_MAY*` 系列位是"曾经允许过什么"的掩码，用于让 `mprotect` 无法越权扩大权限（`PROT_EXEC` 不能凭空出现在只允许 `PROT_READ` 的映射上）：

```text
vm_flags 常见组合与实例
────────────────────────────────────────────────────────────────
VM_READ|VM_WRITE|VM_MAYREAD|VM_MAYWRITE        →  rw-p  Java 堆已 commit 段
VM_READ|VM_WRITE|VM_EXEC|VM_MAY*               →  rwxp  某些旧 JVM 的 CodeCache
VM_EXEC|VM_READ|VM_MAYEXEC|VM_MAYREAD          →  r-xp  libjvm.so 的 .text
VM_READ                                   ...  →  r--p  libjvm.so 的 .rodata
（全无）VM_MAYREAD|VM_MAYWRITE|VM_MAYEXEC       →  ---p  JVM 预留区 / guard page
VM_READ|VM_WRITE|VM_SHARED|VM_MAPPED_COPY      →  rw-s  /tmp/hsperfdata_<u>/<pid>
```

注意最后一行：`rw-s`（共享文件映射）在 Java 进程里非常常见，它是 `jcmd`/`jstat` 与 JVM 通信的 `hsperfdata` 文件，第 9.3 节会讲它的生命周期为什么跟随 fd 而不是跟随进程逻辑。

## 2.3 VMA 的组织方式：从链表到 Maple Tree

一次 `mmap` 需要找到空档、一次缺页需要按地址找到 VMA、一次 `munmap` 需要删除一段并可能分裂 VMA——这三件事的复杂度全由"VMA 怎么组织"决定。演进历程：

| 内核时期 | 组织方式 | 查找复杂度 | 说明 |
|---|---|---|---|
| 2.6 之前 | 单链表（按地址有序） | O(n) | 大 VMA 数进程直接劣化 |
| 3.0 ~ 5.x | **rbtree** + 保留链表 | O(log n) | `mm->mm_rb`，同时保留 `vm_next` 便于顺序遍历（`maps` 输出） |
| 4.x | 额外为 `anon_vma` 建 rbtree（`anon_vma_chain` rb 节点） | O(log n) | 服务反向映射，不是 VMA 查找 |
| **6.1+** | **Maple Tree**（`mm->mm_mt`） | O(log n)，但缓存友好、支持范围迭代 | 一次性删除链表，`vm_rb_*` 字段被移除 |

Maple Tree 是一个 **B 树变体**（内部节点存一段连续 range 而非单个 key），带来的实际差别有三点，都会在本文后续章节出现后果：

1. **VMA 分裂/合并的成本结构变化**。`mmap` 落在已有 VMA 中间需要把原 VMA 劈成两半，Maple Tree 用 `mas_split` 一次完成，避免多次树操作；`mprotect`/`madvise` 跨界时同理。
2. **`bpf_iter_task_vma` 成为可能**。迭代器 API 直接遍历 `mm_mt`，eBPF 程序可以安全地在持锁期间逐条读 VMA（第 11.6 节给出脚本）。
3. **数据结构读取工具需要适配**。任何直接读 `mm->mmap` 链表或 `mm->mm_rb` 的调试工具（部分 `crash` 扩展、老版本 `procmem`）在 6.1+ 上会拿到空指针或错值；`vm_start/vm_end` 在部分 6.x 补丁里被移入 `__vm_start/__vm_end` 并配 `MAPI_STATE`，这是编译期细节，运行时排查只需知道"符号名可能变"。

同时期还有一项与生命周期强相关的能力：**per-VMA locks**（6.4 起合入、6.5 继续完善，具体请以目标内核源码确认）。它让缺页路径不再抢 `mmap_lock` 读锁，而只锁住单个 VMA，直接后果是——大堆 JVM 的缺页风暴期间，`fork`/`exit` 不再被 `mmap_lock` 长时间阻塞。这在第 5.4 节和第 12.5 节案例（`exit_mm` 慢）里都会回来说一次。

## 2.4 页表：映射关系的实际载体，也是内存

前两个结构记的是"虚拟"的账，页表记的是"虚拟 → 物理"的实际关系。x86-64 在 4 级页表（默认）下：

```text
虚拟地址 48 位切分（x86-64 4 级）
 63          48 47    39 38   30 29   21 20   12 11        0
┌────────────┬─────────┬────────┬────────┬────────┬─────────┐
│ sign ext.  │   PGD   │  P4D   │  PUD   │  PMD   │  PTE    │ 页内偏移
│  (16)      │  (9)    │  (9)   │  (9)   │  (9)   │  (9)    │ (12)
└─────┬──────┴────┬────┴───┬────┴───┬────┴───┬────┴────┬────┘
      │           │        │        │        │         │
   128TB       512GB    1GB      2MB      4KB     4KB页
  TASK_SIZE     PGD页   P4D页    PUD页     PMD页    PTE页
             (4KB)   (4KB)  (4KB)   (4KB)   (4KB)
```

在开启 `CONFIG_X86_5LEVEL` 且 CPU 支持 LA57 时是 5 级（多一层 P4D 的实体使用，覆盖 4 级时的"物理地址上限"限制，不改变用户可见的 128TB 布局）；aarch64 在 48 位 VA 下同样是 4 级。

关键点：**页表页本身也是内存**，由内核分配（x86 的 PGD 来自 `pgd_cache` slab，PMD/PTE 页来自 `__get_free_page` + `pgtable_pmd_page_ctor`）。它的大小可以被精确算出来，因为每一级都是 512 个 8 字节的表项：

| 覆盖范围 | 需要的页表页数 | 元数据开销 |
|---|---|---|
| 4KB（1 页） | 1 个 PTE 页（服务 512 页共享） | 摊薄后 8 B |
| 2MB（PMD 大页，即 THP） | 无 PTE 页 | **省掉整个 PTE 层** |
| 1GB（PUD 大页，需显式 hugetlb） | 无 PMD/PTE 页 | 再省一层 |

由此得出本文反复使用的一条估算式：**页表元数据 ≈ 驻留内存 / 512**。8GB 驻留对应约 16MB，与前面 `status` 里 `VmPTE: 18136 kB` 的量级吻合（多出的一小部分来自共享库与栈的稀疏映射）。

Java 11 的进程页表树大致长这样（数字为示意，表示实际存在的页表页数）：

```text
mm->pgd  (1 个 PGD 页，512 项)
   │
   ├── 项 [0x0000...] → 用户栈区
   │        P4D → PUD → PMD → 4 个 PTE 页 → 约 2048 个物理页
   │
   ├── 项 → libjvm.so / libc / jar 映射（共享，file-backed）
   │        多个 PTE 页；页表项多数与其他进程内容相同但页不同
   │
   ├── 项 → Java 堆 8GB（连续 4096 个 2MB 区间）
   │        P4D → PUD → PMD × 4096 → PTE × (已 commit 区间数)
   │        ├─ 未 commit 的地址：PMD 之后**根本不存在子表**
   │        └─ THP 命中时：停在 PMD 层，直接指向 2MB 页
   │
   └── 项 → Metaspace / CodeCache / 线程栈（312 段，各 1~2 个 PTE 页）
```

> **关键认知**：未 commit 的地址**不消耗页表内存**——这是 `PROT_NONE` 预留几乎零成本的根本原因（它只花一个 VMA 结构体的几百字节）。反过来，一旦某段地址被大量触碰，页表元数据就成为一笔真实、不可回收的开销，直到 `munmap` 才释放（`MADV_DONTNEED` 会保留页表骨架，只清 PTE 内容）。

## 2.5 用户态地址空间布局与 ASLR 落点

x86-64 用户态可用范围是 `0x0000000000000000 ~ 0x00007fffffffffff`（128TB，`TASK_SIZE`），上面对称的另一半 128TB 留给内核（`direct map` 区把物理内存线性映射在内核窗口里）。一个典型 Java 进程的地址布局如下（自底向上）：

```text
0x000055d3a8c00000  ELF 代码段（PIE：随 ASLR 随机）  r-xp  [exe]
0x000055d3a9e11000  .rodata                          r--p
0x000055d3ab200000  .data / .bss → [heap] brk ↑      rw-p     起始页对齐
        ↑ brk 随机范围：32MB 内（arch_randomize_brk）
        │
   ~~~ 未登记的空洞（任何访问 = SEGV_MAPERR） ~~~
        │
0x00007f2a80000000  Java 堆 8GB（PROT_NONE→rw-p）  ---p/rw-p
0x00007f2bb0000000  glibc arena / malloc 大块        rw-p
0x00007f2c1c000000  libjvm.so / libjava.so 等        r-xp
0x00007f2c6c000000  线程栈 ×312（每段 1MB + guard）  rw-p ---p
0x00007f2c7f9e0000  ld.so / vdso / vvar              r-xp
        ↓ mmap_base 自此向上递减（top-down 分配）
0x00007ffc6a12c000  [stack] 主线程栈（向下生长）     rw-p
        ↑ 与 mmap_base 之间留一段与 L1 数据缓存成正比的空白，
          防止 cache aliasing（x86 的 mb_in_cache_gap）
0xffffe70fe000      [vdso]  0xffffe70fe000          r-xp
0xffffe70ff000      [vvar]                          r--p
0xffffffffff600000  [vsyscall]（固定、不可随机，已废弃）r-xp
```

三段随机化由 `kernel.randomize_va_space` 控制：

| 取值 | 效果 |
|---|---|
| 0 | 全部关闭（仅调试用，性能测试基线可用它复现地址） |
| 1 | 只随机化 mmap 基址与栈 |
| 2 | 额外随机化 `brk`（默认值） |

两个常被忽略的内核参数：

- `vm.mmap_min_addr`（默认 65536）：禁止 VMA 落在低地址，防 NULL 解引用利用。JVM 不受影响，因为它总传 `NULL` 让内核选址。
- `vm.legacy_va_layout`（0/1）：置 1 时 mmap 从 `TASK_SIZE` 往下变成从栈之下往上分配（旧行为）。生产上几乎不用，但它是复现"老内核地址布局"的唯一开关。

`MAP_GROWSDOWN`（自动增长的栈）在现代内核上还有一层保护：`stack_guard_gap`（默认 256 页 = 1MB）。当栈向下扩张时若 1MB 内已有其他 VMA，扩张失败，表现为 `SIGSEGV` 而不是 `SIGBUS`——第 8.6 节讲线程栈时会用到这条。

## 2.6 `/proc/pid/maps` 是怎么被生成的

`maps` 不是缓存，而是每次读都现场遍历 VMA 树生成：

```text
open("/proc/<pid>/maps")
   └─ proc_maps_open()                      fs/proc/base.c
        └─ mm_access()  →  需要 ptrace 权限（同 uid 或 CAP_SYS_PTRACE）
        └─ seq_open(file, &proc_pid_seq_ops)
   read()
   └─ seq_read → seq_ops->start = seq_list_head（持 mmap_lock 读锁）
        └─ show_map_vma(m, vma)             fs/proc/task_mmu.c
             ├─ get_vma_name() → "[heap]" / "[stack]" / "[vdso]" / "[vvar]"
             ├─ vm_flags → 'r'/'w'/'x'/'-' + 'p'/'s'
             └─ seq_printf("%016lx-%016lx %c%c%c%c %016lx %02x:%02x/%lu %08ld %s\n", ...)
   close()
        └─ 释放 mmap_lock 读锁
```

由此得到三条工程结论：

1. **标签来源**。`[heap]` 来自 `vma->vm_start == mm->start_brk` 区间的特殊判断，`[stack]` 来自 `vm_start` 落在栈区或 VMA 带有 `VM_GROWSDOWN`；其余匿名 VMA 没有方括号标签，因此**Java 堆在 maps 里显示为空白名**——这正是第 8 章要教你用 NMT 对账的原因。
2. **快照不是原子的**。`maps` 在持读锁期间逐 VMA 输出，seq_file 缓冲区分多次 `read` 返回，中间可能释放并重取锁；对高并发进程做连续两次 `maps` 差分（第 11.1 节）时，可能观测到"同一 VMA 起止变化"的撕裂现象。
3. **`pmap -x` 与 `maps` 的差别**。`pmap` 额外读了 `smaps`（需要逐页 `walk_page_range`），因此给出每段的 `RSS / Dirty / Mapping` 三列，代价是大堆进程一次 `pmap -x` 可能耗时几百毫秒并持有 `mmap_lock` 读锁——生产上禁止对 >8GB 堆的进程开循环 `pmap -x`，应该改用 `smaps_rollup`（一次遍历，输出汇总）。

`smaps` 相对 `maps` 多出的字段与生成路径：`show_smap()` → `walk_page_range(vma, &smaps_walk)` 统计 `Rss/Pss/Dirty/Swap`，再由 `show_smap_vma_flags()` 把 `vm_flags` 翻译成 `VmFlags:` 行的短码。

## 2.7 三本账本的心智模型

把本章收束成一句可复用的话：**理解地址空间，就是同时盯住三本互相引用的账本。**

| 账本 | 载体 | 记什么 | 何时增 | 何时减 | 何时"看着没减" |
|---|---|---|---|---|---|
| 虚拟账本 | `mm_struct` + VMA 树 | 哪些地址区间被登记、权限如何 | `mmap`/`brk` 增长 | `munmap`/VMA 收缩 | `madvise(MADV_DONTNEED)` 完全不动它 |
| 映射账本 | 页表（PGD→PTE） | 虚拟地址到物理页的翻译 + 保护位 | 缺页提交 | `munmap`/`exit` 释放页表页 | `MADV_FREE` 标脏不立即清 PTE |
| 物理账本 | `mem_cgroup` + 伙伴系统 + rmap | 物理页归属谁、能回收吗、计费给谁 | 缺页时 `alloc_pages` | 页被 unmap 后归还 buddy | RSS 下降滞后于页表清理（THP 拆分、per-CPU pagevec 未 drain） |

后文十二章的案例，本质都是这三本账**出现了不一致**：告警看虚拟账（VSZ 45GB）、监控看物理账（`working_set`）、JVM 看第四本内部账（`Used`）。第 15 章会把这三本账固化成三条不变式。

**本章要点：**

- `mm_struct` 是总账本：`total_vm` 对应 `VmSize`、`map_count` 对应 `vm.max_map_count` 判据、`context`+`mm_cpumask` 决定 TLB flush 的广播成本
- VMA 是状态迁移的最小单位，`/proc/pid/maps` 的一行就是一个 VMA；`rwxp` 四个字符由 `vm_flags` 与 `VM_MAY*` 掩码共同决定，`---p` 即 JVM 的预留区
- VMA 组织从链表 → rbtree+链表 → **Maple Tree（6.1+）**；per-VMA locks（6.4/6.5）让缺页不再抢 `mmap_lock`，直接改变大堆 JVM 的 `fork`/`exit` 阻塞特征
- 页表也是内存，元数据开销约等于驻留内存的 1/512；**未 commit 的地址不消耗页表**，这是 `PROT_NONE` 预留近乎免费的根因
- x86-64 用户态到 `0x00007fffffffffff`，ASLR 分别随机化 ELF 基址、`mmap_base`（top-down）、`brk`（32MB 内）与栈；`stack_guard_gap` 限制栈自动增长
- `maps` 每次读都现场遍历 VMA 树，非原子快照；`pmap -x` 会走 `smaps` 持读锁，大堆进程慎用，应改 `smaps_rollup`
- 记住三本账：虚拟（VMA）× 映射（页表）× 物理（cgroup/buddy），绝大多数内存争议是三本账不一致造成的

---

# 第 3 章：生命周期起点 - 进程创建与地址空间诞生

第 2 章我们拆开了地址空间这台机器的零件：`mm_struct` 是总账本，VMA 是状态迁移的最小单位，页表是虚拟到物理的翻译表。本章要从**账本被翻开的第一页**讲起——一个新的 `mm_struct` 是怎么诞生的，`execve` 为什么要"换账本"而不是"改账本"，Java 进程刚睁开眼时地址空间里究竟有什么，以及为什么一个 312 线程的 JVM 只有一份地址空间。

这一章决定了后面十二章的所有"归因起点"。当你看到某个可疑地址，第一反应不该是"它什么时候被分配了物理页"，而是"**它是被谁放进这棵 VMA 树的**"。

## 3.1 三条入场路径：fork、vfork 与 clone

Linux 里所有用户态进程与线程的出生，最终都收敛到同一个系统调用 `clone(2)`（`fork(2)`、`vfork(2)`、`pthread_create(3)` 都是它的封装）。它们的差异**只有一个比特**：`CLONE_VM`。

内核侧的分叉点就在 `kernel_clone() → copy_process() → copy_mm()`：

```c
static int copy_mm(unsigned long clone_flags, struct task_struct *p)
{
	struct mm_struct *mm, *oldmm = current->mm;

	if (!oldmm)
		return 0;                      /* 内核线程没有用户地址空间 */

	if (clone_flags & CLONE_VM) {
		mmget(oldmm);                  /* 路径 A/C：只加一次引用计数 */
		mm = oldmm;
	} else {
		mm = dup_mm(p);                  /* 路径 B：新建 mm，复制全部 VMA 与页表 */
		if (!mm)
			return -ENOMEM;
	}

	p->mm = mm;
	p->active_mm = mm;
	return 0;
}
```

三条路径的语义、成本与后果：

| 路径 | clone_flags | 是否新建 `mm` | 页表处理 | 父进程状态 | 典型调用者 |
|---|---|---|---|---|---|
| A 线程 | `CLONE_VM`（+`CLONE_THREAD`/`CLONE_SIGHAND`/`CLONE_FS`…） | 否，共用 | 不动 | 继续运行 | `pthread_create`、`os::create_thread` |
| B 进程 | 0（`fork(2)`） | 是，`dup_mm` | 全量复制 + COW 写保护 | 继续运行 | shell、`ProcessBuilder` |
| C 半程 | `CLONE_VM \| CLONE_VFORK` | 否，共用 | 不动 | **阻塞**，直到子进程 `execve` 或 `_exit` | `posix_spawn`、动态链接器的 `vfork` |

它们的取舍逻辑可以画成一棵树：

```text
                      clone(flags)
                            │
                  ┌─────────┴──────────┐
            CLONE_VM=0            CLONE_VM=1
                 │                     │
        ┌────────┴────────┐      ┌─────┴──────┐
   （普通 fork）      （需要新账本） CLONE_VFORK? │
        │                     │        │        │
   mm_alloc()             否：线程   是：vfork  │
   + dup_mmap()           共享父 mm  共享 + 暂停 │
   + copy_page_range()                 父进程   │
   （成本 ∝ VMA 数 + 驻留页数）                   │
                                                 ▼
                                        仅 clone + 立刻 execve
                                        （成本 ≈ 常数）
```

`vfork` 的存在意义在 Java 场景里格外重要：**它把"创建一个进程"的成本从"与地址空间大小成正比"降为"与地址空间大小无关"**。代价是子进程在 `execve` 之前绝对不能改写地址空间（因为它和父进程共用一份），也不能从调用 `vfork` 的函数返回。glibc 的 `posix_spawn` 内部正是用这套语义来避免大地址空间进程 `fork` 的巨额开销。

`dup_mmap` 的成本结构值得单独写清楚：

```text
fork 的墙钟成本 ≈
      map_count            × 分配并插入一个 VMA（Maple Tree + slab）
    + 已建立的中间页表页数  × 复制一份页表页
    + 驻留的私有可写页数    × 逐条 PTE 清写位（COW）
    + 需要广播的 CPU 数     × TLB shootdown（IPI）
```

拿第 2 章那组基准数字代入：`VmRSS` 为 9,134,588 kB，即约 2,283,647 个驻留页。其中 `RssAnon` 高达 8,902,164 kB，绝大部分是 Java 堆——它们全是私有可写匿名页，`copy_page_range` 必须**逐条把 PTE 改成只读**并记录 COW 状态。这意味着：

- 在这个 JVM 存活期间 `fork` 一次，父进程要交出一次全量页表遍历，父子双方的后续每一次堆写入都会触发一次 COW 缺页；
- 反过来，**那 8GB 里没被触碰过的部分对 `fork` 几乎是免费的**——它只存在于 VMA 树里，页表是空的，`copy_page_range` 走不到那些层。这正是"三本账"在性能上的第一次显形：`VmSize` 决定 `map_count` 相关成本，`VmRSS` 决定页表复制成本。

所以"8GB 堆的 Java 进程 `fork` 很慢"这个结论，真正的变量不是 `-Xmx`，而是 `-Xms` 和已分配对象的量（也就是 RSS）。一个 `-Xms8g -Xmx8g -XX:+AlwaysPreTouch` 的空闲 JVM，`fork` 成本会显著高于一个 `-Xmx8g` 但只用 300MB 的 JVM，即便两者 `VmSize` 相同。

> **注意**：`fork` 时内核只复制页表的**结构与内容**，不复制物理页，所以真正的成本项是页表遍历本身。而这次遍历是否**长时间独占 `mmap_lock`**，取决于内核在 `copy_page_range` 里有没有"复制若干页表项就放开一次锁"的批处理机制——较新版本内核为 `fork` 加了这类阈值，专门为了避免大 RSS 进程 `fork` 时饿死同进程其他线程的缺页分配。批处理阈值与合入版本请以目标内核源码确认，它直接决定了第 11 章里"JVM 主线程在一次 `fork` 期间被卡多久"的答案。

Java 工程师要记住的推论是：`Runtime.exec` / `ProcessBuilder` 在历史上会给大堆 JVM 带来一笔隐蔽的开销。不同 JDK 小版本在这条路径上做过调整（`forkAndExec`、`posix_spawn` 等实现路径并存），是否绕开了完整 `fork` **必须以目标 JDK 小版本实测确认**（用 `strace -f -e trace=clone,clone3,vfork` 观察启动一个子进程时的系统调用即可）。

## 3.2 mm_alloc 与 mm_init：账本被翻开的第一页

无论是 `dup_mm` 还是 `bprm_mm_init`，一个新的 `mm_struct` 都来自同一对函数：

```c
struct mm_struct *mm_alloc(void)
{
	struct mm_struct *mm = allocate_mm();   /* 从 mm_cachep（slab）拿一个对象 */
	return mm_init(mm, NULL, NULL);
}
```

`allocate_mm()` 说明了一件事：**`mm_struct` 本身是 slab 里的一小块内核内存**，约 1KB 量级（随配置变化），它的分配走的是伙伴系统 + slab 分配器，与用户地址空间无关——这部分细节见姊妹篇《系统内核基础结构分析》，此处不重复。

`mm_init()` 才是"生命起点"的定义。一个刚 `mm_init` 完的 `mm_struct`，有六个必须盯住的**零值**，它们构成了后文所有对账的坐标原点：

| # | 字段（或其等价观测口） | 出生值 | 谁会把它推高 | 用户态可见口 |
|---|---|---|---|---|
| 1 | `mm_mt`（Maple Tree）为空、`map_count = 0` | 无 VMA | `mmap_region`、`vma_link`、`brk` | `/proc/<pid>/maps` 行数 |
| 2 | `mm->total_vm = 0` | 0 页 | 每次 VMA 插入累加 | `VmSize: 0 kB` |
| 3 | `mm->data_vm / exec_vm / seg_hdr_vm = 0` | 0 页 | `vm_stat_account` 按 `vm_flags` 归类 | `VmData` / `VmExe` / `VmHdr` |
| 4 | `mm->rss_stat.count[] = 0` | 0 页 | 缺页提交时 `dec_zone_page_state`/`mm->rss_stat` 累加 | `RssAnon` / `RssFile` |
| 5 | `mm->pgd` 指向一张**空** PGD | 几 KB | 中间级页表延迟分配 | `VmPTE: <几 kB>` |
| 6 | `start_brk = brk = end_brk = 0`；`start_code/end_code/start_stack` 未填 | 无堆段 | `load_elf_binary`、`set_brk` | `maps` 里无 `[heap]` |

第 5 行的机制必须展开讲，因为它是"**预留近乎免费**"的第二个原因（第一个是 `PROT_NONE` 不建 PTE）：

```text
出生时内核只保证顶层存在：
   PGD（x86-64 四页表时 1 个页；pgd_alloc 还会预置顶层的少量页，量级为个位数页）
     └── PUD   ← 不存在
           └── PMD  ← 不存在
                 └── PTE ← 不存在

直到第一次缺页，handle_mm_fault 才按需补齐缺的那几级：
   ___handle_fault → mmap 锁/per-VMA lock → handle_mm_fault
      → mm_p4d_alloc → mm_pud_alloc → mm_pmd_alloc → mm_pte_alloc
      → alloc_pages 拿物理页 → set_pte_at
```

也就是说，一个 `mmap` 出来的 8GB `PROT_NONE` VMA，在页表里**只消耗一个 PGD 表项**（如果它跨过了 PGD 边界才会多占几个）。这就是第 2 章那条"页表元数据 ≈ 驻留内存 / 512"的微观成因：元数据是按"驻留的稀疏程度"分配的，不是按"预留的总量"分配的。基准数据里 `VmPTE: 18136 kB` 对应 `VmRSS: 9134588 kB`，比值约 504，与理论值 512 的偏差来自页表自身的层级碎片和共享库的映射分布——这类偏差是正常的，量级对得上就说明没有页表泄漏。

另一个容易忽略的细节是 `mm_init` 里的 `mm_init_cpumask(mm)`：它把 `mm_cpumask(mm)` 清空，表示"这份地址空间当前不在任何 CPU 的 TLB 里"。此后每次 `use_mm`/`switch_mm` 都会把对应 CPU 的比特置上。**TLB flush 的广播范围由这张掩码决定**，一个 312 线程、在 96 核机器上跑起来的 JVM，其 `mm_cpumask` 往往是满的，这就解释了第 2 章提到的"大堆进程 `munmap` 时 TLB 广播成本极高"。

最后是双引用计数，它决定了"销毁"阶段的两个不同时刻：

```text
mm_count  ：这份地址空间"还存在吗"（被 mmu_gather / 内核线程 active_mm 引用时也算）
mm_users  ：有多少任务"正在用它"（线程数 + 1 个 fork 出的进程）

线程退出 → mmput → mm_users 归零 → exit_mmap()  （拆 VMA、拆页表、还物理页）
                                     ↓
                         free_pgtables / tlb_finish_mmu
                                     ↓
                       mm->mmap_base 等彻底失效
                                     ↓
          mm_count 归零 → mmdrop → __mmdrop → pgtable_pmds_dtor + pgd_free + kmem_cache_free
```

关键差别是：`exit_mmap` 是**重活**（遍历 VMA 树、zap 全部页表、把几百万个物理页还给伙伴系统），它在最后一个线程退出的那次 `exit_group` 里同步执行；而 `__mmdrop` 是**轻活**，且内核为了避免在进程退出的关键路径上释放页表页，把 PGD/PMD 页表的释放放进了 `deferred_free_mm`（`free_mm` 走 RCU/`mm_kfree` 异步路径）。第 15 章会用这个机理解释一个常见困惑："Java 进程已经 `exit` 了，为什么 `free` 还没涨回来"。

## 3.3 execve：换账本，而不是改账本

这是全章最重要的一节。绝大多数人以为 `execve` 是"把当前进程变成另一个程序"，内核的真实做法是：**给任务换上一本全新的账本，然后把旧账本扔掉。**

```text
sys_execve / sys_execveat
  └─ do_execveat_common
      ├─ bprm 初始化（binprm 结构：filename / cred / buf / mm / p）
      ├─ prep_bprm → bprm_mm_init
      │     └─ mm_alloc()  ←★ 此刻新建一个"临时" mm（bprm->mm）
      │        并在这本新账本里插一个栈 VMA（大小按 RLIMIT_STACK）
      │        ARG/ENV 字符串的暂存位置由 bprm->p 逐步下压
      ├─ open_exec / prepare_binprm
      │     └─ 读文件头 128 字节进 bprm->buf，判 binfmt；置 setuid/cred
      ├─ search_binary_handler
      │     ├─ load_script      ← shebang：改写 bprm 后再次 search_binary_handler
      │     ├─ load_elf_binary  ← 主力路径
      │     │     ├─ read_elf_header / 遍历 phdr（PT_LOAD / PT_INTERP /
      │     │     │     PT_GNU_STACK / PT_GNU_RELRO）
      │     │     ├─ load_elf_interp → elf_map(ld-linux.so)
      │     │     ├─ begin_new_exec   ←★★ 不可回头点
      │     │     │     ├─ exec_mmap(bprm->mm)：current->mm 指向新账本
      │     │     │     ├─ 旧 mm 走 exit_mm/exit_mmap（旧 VMA 全部消失）
      │     │     │     ├─ 重置 signal handlers / 关闭 O_CLOEXEC fd
      │     │     │     ├─ set_user_nice、arch_setup_additional_pages([vdso])
      │     │     │     └─ mm->fdt 换表、PR_SET_PTRACER 复位
      │     │     ├─ elf_map 各 PT_LOAD → 首批 file VMA
      │     │     ├─ create_elf_tables（写 auxv：AT_RANDOM/AT_EXECFN/AT_SYSINFO_EHDR…）
      │     │     └─ setup_arg_pages：把 ARG/ENV 页搬到最终栈位置
      │     └─ set_brk：把 [heap] VMA 开到 BSS 末尾
      └─ start_thread(regs, entry, bprm->p)   ← 只改寄存器，"返回"到新程序第一条指令
```

三个必须理解的推论。

**推论一：`execve` 之后 VMA 树是从零开始的。** 旧进程的堆、mmap 段、JIT 代码缓存统统不存在了——它们随 `exit_mmap` 一起被 zap。这就解释了为什么 shell 里 `java -version; exec java -jar app.jar` 比 `java -version; java -jar app.jar` 少一份常驻内存：`exec` 让第二个 java **复用同一个 task，换掉 mm**，而不是再走一遍 `fork + execve`。

**推论二：`begin_new_exec` 是"不可回头点"（point of no return）。** 在它之前，任何失败都只是让 `execve` 返回 `-1` 并置 `errno`，进程还是原来那个进程；在它之后，旧账本已经被扔掉、signal handlers 已经清空、fd 表已经换过，**内核不可能把进程还原回去**。所以内核代码里对应的兜底是：若 `execve` 已经越过这一点却仍然失败（例如 `setup_arg_pages` 返回 `-ENOMEM`），就直接给该任务投递 `SIGKILL`，而不是把错误码交给用户态。工程含义很实在：**一个在容器里 `exec` 失败但进程"还活着"的现象，几乎必然是错误发生在 `begin_new_exec` 之前**；反之，如果看到 java 进程刚出现就收到 SIGKILL 且日志一片空白，要怀疑 execve 之后的装载失败或 cgroup 拦截。

历史上这个函数叫 `flush_old_exec`，5.8 内核把它拆成了 `begin_new_exec` 加前半段的 `flush_old_exec`，拆分目的正是把"不可回头"的语义在函数名上讲清楚。这个命名差异会直接影响你读源码或搜 commit 的路径。

**推论三：shebang 会走第二次 execve 解析。** `#!/bin/sh` 包装脚本命中的是 `binfmt_script`（`load_script`）：内核解析脚本首行，把解释器路径插到 argv 最前面，然后**递归调用 `search_binary_handler`**（递归层数有上限，超了会 `-ELOOP`）。对 Java 场景来说，`/usr/bin/java` 在不少发行版里是**带 shebang 的 shell 包装脚本**（Debian 系的 alternatives 常见），此时真实地址空间的诞生要经历"解释器 `sh` 的 mm → `exec` java 又换一次 mm"，多一轮完整装载。排查"我的 `-Xmx` 明明设置了但进程命令行里没有 `-Xmx`"这类问题时，`cat /proc/<pid>/cmdline | tr '\0' ' '` 与 `ls -l /usr/bin/java` 是第一组该看的命令——容器镜像里用一个 wrapper 脚本包 java，是很多诡异行为的源头。

## 3.4 ELF 装载：进程睁眼时地址空间里的首批 VMA

`load_elf_binary` 是"首批 VMA 从哪来"的唯一答案。先看一个 Java 11 启动器的 ELF 头与程序头表：

```bash
readelf -h /opt/jdk-11/bin/java
readelf -l /opt/jdk-11/bin/java
```

```text
ELF Header:
  Type:    DYN (Position-Independent Executable file)
  Machine: Advanced Micro Devices X86-64
  Entry point address:               0x1180
  ...

  Type           Offset   VirtAddr         FileSiz    MemSiz   Flg Align
  INTERP         0x000318 0x0000000000000318 0x00001c 0x00001c R   0x1
      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]
  LOAD           0x000000 0x0000000000000000 0x000670 0x000670 R   0x1000
  LOAD           0x000670 0x0000000000000670 0x001b59 0x001b59 R E 0x1000
  LOAD           0x0021d0 0x00000000000031d0 0x0002a0 0x0002a0 R  0x1000
  LOAD           0x002470 0x0000000000004470 0x000198 0x000198 RW 0x1000
  GNU_PROPERTY   0x00021d0 0x00000000000031d0 0x0002a0 0x0002a0 R  0x1
  GNU_EH_FRAME   0x002600 0x0000000000003600 ...                    R   0x4
  GNU_STACK      0x000000 0x0000000000000000 0x000000 0x000000 RW   0x10
  GNU_RELRO      0x0021d0 0x00000000000031d0 0x000590 0x000590 R    0x1
```

程序头到 VMA 的对应关系：

| ELF 程序头 | 内核处理 | 落地成什么 VMA |
|---|---|---|
| `PT_LOAD`（Flg `R`） | `elf_map` → `vm_mmap` file-backed，`PROT_READ` | `r--p`，指向可执行文件 |
| `PT_LOAD`（Flg `R E`） | `elf_map`，`PROT_READ\|PROT_EXEC` | `r-xp`，代码段 |
| `PT_LOAD`（Flg `R W`） | `elf_map`，`PROT_READ\|PROT_WRITE`；`MemSiz > FileSiz` 的差额为 BSS | `rw-p`（含尾部零页） |
| `PT_LOAD` 相邻且权限一致 | 内核尽量合并；跨页对齐后可能出现一段匿名尾巴 | `rw-p` 无名行（BSS 尾巴） |
| `PT_GNU_STACK`（`RW`） | 记入 `read_only_implies_exec`/`executable_stack` 判定，决定栈 VMA 是否可执行、是否 `READ_IMPLIES_EXEC` | 影响 `[stack]` 的 `vm_flags` |
| `PT_GNU_RELRO` | **内核不改权限**；重定位完成后由 ld.so 调 `mprotect(PROT_READ)` | `rw-p` → `r--p` |
| `PT_INTERP` | `load_elf_interp` 再走一次 `elf_map` 装载 `ld-linux-x86-64.so.2` | 额外的 file VMA + `[ anon ]` |
| 无 `PT_INTERP`（静态） | 直接进 `create_elf_tables` | 少了动态链接器的映射 |

`PT_GNU_RELRO` 这一行值得停一下：它是全篇文章里"**应用层库自己发起 `mprotect`**"的第一个例子。内核只负责把段映射成 `rw-p`，真正把它变成 `r--p` 的是 glibc 的动态链接器。这条 `mprotect` 在 `strace` 里出现在 `execve` 之后、`main` 之前，属于**装载期状态迁移**，与 JVM 运行期的 commit/uncommit 是两码事。你在 1.1 节的 strace 里看到的 `mprotect(0x7f..., 8192, PROT_READ)` 就是它。

紧随其后的是内核塞进去的两个"非文件、非匿名"的特殊 VMA，由 `arch_setup_additional_pages` 建立：

```text
7ffc3a180000-7ffc3a184000 r--p 00000000 00:00 0   [vvar]
7ffc3a184000-7ffc3a186000 r-xp 00000000 00:00 0   [vdso]
ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0  [vsyscall]
```

`[vdso]`/`[vvar]` 让 `gettimeofday`、`clock_gettime`、`getcpu` 不用陷入内核即可完成时间读取。它们对 Java 有两层意义：一是 `maps` 里识别"内核送的段"的锚点，看到 `[vdso]` 说明前面的行大概率是内核装载期的产物；二是 HotSpot 的 OSR/时间戳、GC 的 `os::elapsedTime` 会高频走这里，第 10 章讨论 CPU/内存联合排查时它会再次出现。`[vsyscall]` 是历史遗留页，现代发行版默认已用 `--xp` 或不启用（`vm.vsyscall_0`、`vdso=0` 启动参数可关），需要以具体内核配置确认。

把 `execve` 返回、`main` 即将执行之时的 `maps` 写全，一个 Java 11 启动器（动态链接、PIE 构建）大概是这样——**注意这里只有十几条 VMA，一条 8GB 的影子都没有**：

```text
55e6a8c00000-55e6a8c01000 r--p 00000000 08:01 131   /opt/jdk-11/bin/java
55e6a8c01000-55e6a8c03000 r-xp 00001000 08:01 131   /opt/jdk-11/bin/java
55e6a8c03000-55e6a8c04000 r--p 00003000 08:01 131   /opt/jdk-11/bin/java
55e6a8c04000-55e6a8c05000 rw-p 00004000 08:01 131   /opt/jdk-11/bin/java
7f2c00000000-7f2c00021000 r--p 00000000 08:01 140   /usr/lib/.../libjli.so
7f2c00040000-7f2c002a6000 r--p 00000000 08:01 141   /usr/lib/.../libc.so.6
...（ld.so 依 DT_NEEDED 继续 mmap 若干 .so）
7ffd8c123000-7ffd8c145000 rw-p 00000000 00:00 0     [stack]
7ffd8c180000-7ffd8c184000 r--p 00000000 00:00 0     [vvar]
7ffd8c184000-7ffd8c186000 r-xp 00000000 00:00 0     [vdso]
```

（JDK 官方 tar 包里的 `java` 在部分版本是 `EXEC` 而非 `DYN`，基址形态随之不同；上表按 PIE 举例，具体以 `readelf -h` 实测为准。）

## 3.5 ASLR：五个随机落点，以及一个常见误读

内核在装载期一共做**五处独立随机化**，理解它们才能看懂 `maps` 里的地址分布，也才能理解 4.2 里"地址碎片导致预留失败"的根因。

| 落点 | 决定者（函数名以 x86-64 为例） | 随机化幅度 | 影响的地址 |
|---|---|---|---|
| 可执行文件基址 | `ELF_ET_DYN_BASE` + `PF_RANDOMIZE` | 页对齐的高位随机 | `java` 与所有 DSO 的 `0x55e6...` 前缀 |
| `mmap_base`（top-down） | `arch_pick_mmap_layout` → `mmap_base` | 与栈/进程基址联动的随机 | **所有 `mmap(NULL,...)` 的起点**，包括 JVM 堆 |
| 传统 bottom-up 基址 | `mm->mmap_legacy_base`（`vm.legacy_va_layout=1` 时生效） | 独立随机 | 老布局下的 `mmap` 落点 |
| `brk` | `arch_randomize_brk` | 默认在约 32MB 窗口内随机 | `[heap]` 位置 |
| 栈顶 | `randomize_stack_top` + `setup_arg_pages` 的页内 shift | 页级随机 + 页内偏移 | `[stack]`，以及 `AT_RANDOM` 位置 |

`/proc/sys/kernel/randomize_va_space` 控制总开关：

```text
0  关闭全部随机化（可执行文件、mmap、brk、栈都变成确定布局）
1  部分随机化（栈 / mmap_base / vdso，brk 不随机）
2  完全随机化（默认，额外随机化 brk）
```

两个工程要点：

**第一，这个 sysctl 是节点级、未被 namespace 化。** 在 Kubernetes 里，你无法给某个 Pod 单独设置 `randomize_va_space`；`sysctl` 白名单里也没有它。想关闭只能改节点：`sysctl -w kernel.randomize_va_space=0`，或者用带 `privileged` 的 initContainer / 节点级 tuning DaemonSet 写 `/proc/sys/kernel/randomize_va_space`。无论哪种方式，影响范围都是**整个节点上的所有进程**，等于放弃了全节点 ASLR 防护。这也是"为了复现某个地址而在测试节点关 ASLR"要谨慎的原因。

**第二，别把"地址很整齐"当成"ASLR 没生效"。** 这是全章最想纠正的误读。回看 1.1 节里那条 `mmap(NULL, 8589934592, PROT_NONE, ...) = 0x7f2a80000000`——末尾 7 个零，看起来像 `randomize_va_space=0`。真相是：HotSpot 的 `VirtualSpace` 需要大对齐（G1 的 Region 对齐、大页 2MB 对齐），它的常规手法是**先多预留一段、检查落点是否对齐、不整齐就 `munmap` 后重投**，或者预留后在内部切掉不对齐的头尾。于是你看到的是一个**被应用层裁剪过的对齐地址**，而高位随机化依然生效。验证方法只有一个：

```bash
java -XshowSettings:all -version 2>&1 | grep -i aslr
sysctl kernel.randomize_va_space
cat /proc/<pid>/maps | head -3
```

把同一个 java 命令连续跑三次看 `maps` 首行基址：三次都不同 ⇒ ASLR 正常；但每次 java 进程里那 8GB 的 VMA 起始地址都是 2MB 对齐的（甚至 `0x...80000000` 形态）⇒ 这是 HotSpot 的对齐纪律，不是内核的懒惰。同理，`cat /proc/<pid>/auxv` 里的 `AT_RANDOM` 给了 glibc 一份 16 字节随机数（用于栈保护金丝雀与 TLS 随机化），它的存在与否也是一个侧面证据。

## 3.6 Java 11 实证：从 execve 到第一条 8GB VMA

把 3.3～3.5 的机制贴到 Java 11 的真实启动序列上，得到这张时间线表。请特别注意：**`-Xmx` 出现在哪一行，就决定了它在哪一刻才变成 VMA。**

| 阶段 | 触发者 | 地址空间后果 | 可观测指纹 |
|---|---|---|---|
| T0 shell `fork`/`posix_spawn` | shell | 复制 bash 的 mm（很小） | `clone`/`vfork` + `execve` |
| T1 `execve("/…/java")` | 内核 | **新 mm**，10~20 条 file VMA + `[stack]/[vdso]` | `execve(...) = 0`，`maps` 行数 < 40 |
| T2 ld.so 解析依赖 | glibc | `libjli.so`、`libz.so` 等 file VMA + RELRO 收紧 | 若干 `openat` + `mmap(PROT_READ)` + `mprotect(..., PROT_READ)` |
| T3 `JLI_Launch` 解析命令行 | `java` 启动器 | **仅字符串**，地址空间不变 | `-Xmx8g` 此刻还没任何内核意义 |
| T4 `dlopen("libjvm.so")` | `libjli` → `LoadJavaVM` | 一个巨大的 file VMA 组（约几十 MB `r-xp`） | `openat(.../server/libjvm.so)` + 多条 `mmap` |
| T5 `JNI_CreateJavaVM` → `Threads::create_vm` → `os::initialize` | HotSpot | **`-Xmx` 在这里变成 VMA** | 8GB `PROT_NONE` `mmap` |
| T6 堆 commit（`-Xms`） | HotSpot `os::commit_memory` | 同一段地址权限变 RW | `mprotect(基址, Xms 字节, PROT_READ\|PROT_WRITE)` |
| T7 GC/JIT/VM 线程创建 | `os::create_thread` | 每条线程 2 条 VMA（栈 + guard） | `clone(... CLONE_VM ...)` |
| T8 Metaspace / CodeCache | HotSpot `VirtualSpace` | 各自的预留 VMA，按需 commit | 若干 `mmap(PROT_NONE)`+`mprotect` |
| T9 应用首次分配对象/加载类 | 缺页 | `RssAnon`/`VmPTE` 开始爬升 | `maps` 不变，`smaps` 变 |

对照 strace，T4 到 T6 的真实形态。这里抓的是**另一次启动**，参数为 `-Xms512m -Xmx8g`，与 1.1 节那次 `-Xms8g -Xmx8g` 故意不同，就是为了把 commit 长度的差异显出来（省略无关行，注意 `libjvm.so` 的映射是 **file-backed** 的，且分成了 `PROT_READ` 与 `PROT_READ|PROT_EXEC` 两次 `mmap`，第二次带 `MAP_FIXED`）：

```text
openat(AT_FDCWD, "/opt/jdk-11/lib/server/libjvm.so", O_RDONLY|O_CLOEXEC) = 3
read(3, "\177ELF\2\1\1\3...", 832) = 832
mmap(NULL, 30164592, PROT_READ, MAP_PRIVATE|MAP_DENYWRITE, 3, 0) = 0x7f2c10000000
mprotect(0x7f2c100c5000, 20971520, PROT_NONE) = 0
mmap(0x7f2c100c5000, 16384000, PROT_READ|PROT_EXEC, MAP_PRIVATE|MAP_FIXED|MAP_DENYWRITE, 3, 0xc5000) = 0x7f2c100c5000
mmap(0x7f2c11076000, 4628480, PROT_READ, MAP_PRIVATE|MAP_FIXED|MAP_DENYWRITE, 3, 0x1076000) = 0x7f2c11076000
mmap(0x7f2c11505000, 20480, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_FIXED|MAP_DENYWRITE, 3, 0x105000) = 0x7f2c11505000
close(3) = 0
...
mmap(NULL, 8589934592, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0) = 0x7f2a80000000
mprotect(0x7f2a80000000, 536870912, PROT_READ|PROT_WRITE) = 0
```

最后两行是本章与下一章的分界线，也是最值得反复看的一对：

- `mmap(NULL, 8589934592, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_NORESERVE, -1, 0)`：**开辟**。8GB 地址进 VMA 树，`VmSize` 瞬间 +8388608 kB，`VmRSS` 与 `VmPTE` 纹丝不动，`Committed_AS` 因为 `MAP_NORESERVE` 也**没有**增加（第 4.5 节展开）。
- `mprotect(0x7f2a80000000, 536870912, ...)`：**提交**。注意第二个参数是 **536870912（512MB）**，不是 8GB——因为这条命令是 `java -Xms512m -Xmx8g`。commit 的长度等于 `InitialHeapSize`，与 `MaxHeapSize` 无关。

于是有一个几乎可以当"指纹"用的判据：

```text
第一次针对堆基址的 mprotect 长度 ≈ -Xms（InitialHeapSize，含对齐取整）
被 mmap(PROT_NONE) 圈住的总长度   ≈ -Xmx（MaxHeapSize）
两者相差的倍数，就是这个 JVM 未来"允许自己长多大"的余量。
```

如果启动参数加了 `-XX:+AlwaysPreTouch`，你会在这里多看到 `madvise(..., MADV_POPULATE_WRITE)`（较新 glibc/内核组合）或密集的缺页，`RssAnon` 在启动阶段就直接爬到接近 `-Xms`；老版本 JDK 是 HotSpot 自己逐页写零触发缺页。具体走哪条取决于 JDK 小版本与 glibc 版本，需要实测确认。

另外两个常被塞进这张时间线但其实**不属于 `execve`** 的参数：

- `-Xss`（`ThreadStackSize`）生效于 T7 的 `clone` 路径，见 3.7；
- `-XX:MaxDirectMemorySize` 与 `DirectByteBuffer` 的内存**根本不是 mmap**，而是 glibc `malloc`/`mmap`（arena 由 malloc 阈值决定），见 8.7。

## 3.7 线程与 mm 共享：312 个线程为什么只有一份地址空间

`pthread_create` 最终落到 `clone(CLONE_VM|CLONE_THREAD|CLONE_SIGHAND|CLONE_SETTLS|...)`。按 3.1 的 `copy_mm`，`CLONE_VM` 分支只做 `mmget(oldmm)`——**新任务与父任务指向同一个 `mm_struct`**。所以：

- 一个 java 进程 312 线程，`/proc/<pid>/status` 里 `Threads: 312`，但 `map_count` 不会因为"有 312 份地址空间"而膨胀；
- 任何线程 `mmap` 出来的地址，**所有线程立刻可见**，不需要任何同步；
- 代价是：任何线程的 `mmap`/`munmap`/`mprotect` 都要拿**同一把** `mmap_lock`（写锁），这就是第 11 章"JVM 卡顿与 `mmap_lock` 争用"的物理基础。

但线程**确实**会往 VMA 树里加东西，加的是它自己的栈。HotSpot 在 `os::create_thread` 里把 `-Xss` 换算成栈大小，通过 `pthread_attr_setstacksize`（必要时配合 `pthread_attr_setguardsize`）交给 glibc；glibc 的 `allocate_stack` 再决定映射布局。关键点是 **guard page 是一条独立的 `PROT_NONE` VMA**，于是一条线程栈在 `maps` 里通常长这样：

```text
7f2a1c1ff000-7f2a1c200000 ---p 00000000 00:00 0        ← guard（PROT_NONE）
7f2a1c000000-7f2a1c1ff000 rw-p 00000000 00:00 0        ← 线程栈本体（1MB - 4KB）
```

由此得到一条非常重要的**容量判据**：

```text
线程类 VMA 数量 ≈ 线程数 × (1 或 2)
    ×2：guard 独立成段（glibc 默认 guardsize > 0）
    ×1：guardsize 为 0，或 guard 被合并进相邻段
基准进程 Threads: 312 ⇒ 最多约 624 条线程栈相关 VMA
```

为什么强调"可能不下降"：glibc 有**线程栈缓存**（`stack_cache`，进程退出线程时把栈块挂回缓存以便复用，缓存上限与 `PTHREAD_STACK_MIN`/线程数相关）。所以当应用频繁创建销毁线程时，你会看到 `Threads` 从 312 掉到 20，而 `wc -l /proc/<pid>/maps` 的数字**几乎不动**——VMA 没被 `munmap`，只是在线程缓存里排队。这是排查"map_count 越涨越高"时最容易误判成"内核没回收"的一个正常现象。

把判据落成命令：

```bash
wc -l /proc/<pid>/maps                 # 当前 VMA 条数，即 map_count
sysctl vm.max_map_count                # 默认 65530
awk 'END{print NR}' /proc/<pid>/maps   # 等价写法
```

`map_count` 触顶时 `mmap_region` 直接返回 `-ENOMEM`，HotSpot 侧表现为 `os::reserve_memory` 失败并报 `There is not enough space to reserve ...`（或启动期 `Native memory allocation (mmap) failed`）。这里还藏着一个内核的小设计：栈自动增长路径 `expand_downwards` 要求 `map_count` 留出余量（内核里以 `sysctl_max_map_count - 3` 为界），**否则宁肯让栈溢出成 SIGSEGV 也不插新 VMA**。所以一个逼近 `max_map_count` 的 JVM，最先出现的诡异现象常常是**某个线程栈溢出**，而不是 `mmap` 失败。

需要修正一个流行归因：`map_count` 撞上限的主要贡献者**不是线程数**（1 万线程也就 2 万条），而是：

1. glibc malloc arena 的 heap 段（`HEAP_MAX_SIZE` 与 mmap 阈值共同决定，容器 `nproc` 被放大时会创建成倍 arena，第 12 章案例 3 专讲）；
2. HotSpot 的 Metaspace/CodeCache `VirtualSpaceNode` 分块（每次分块 1~2 条）；
3. 第三方分配器（jemalloc/tcmalloc）的分片映射，以及 JNI 库自带分配器的碎片；
4. `hsperfdata`（`/tmp/hsperfdata_<user>/<pid>`）这类 `MAP_SHARED` 文件映射的反复增删。

这条判据会作为第 12 章案例 2（线程数爆炸）与案例 3（arena 爆炸）的共用公式。

**本章要点：**

- 所有出生路径收敛到 `clone`，差异只在 `CLONE_VM` 一个比特：不共享则 `mm_alloc + dup_mmap + copy_page_range`（fork），共享则 `mmget`（线程），共享且父暂停则 `vfork`（`posix_spawn` 的基础）
- `fork` 的成本正比于 `map_count` 与**驻留页数**，与 `VmSize` 基本无关：8GB 堆里没触碰过的部分在页表里是空的，复制成本近乎为零，所以 `-Xms`+实际用量比 `-Xmx` 更能决定 `fork` 代价
- `mm_init` 后的六个零值（`map_count`、`total_vm`、`data_vm`、`rss_stat`、空 PGD、`brk` 三兄弟）是全文所有对账的坐标原点；只有 PGD 出生即建，中间级页表全部延迟到缺页，这是"预留不花钱"的第二因
- `execve` 是**换 `mm` 不是改 `mm`**：`bprm_mm_init` 先建临时账本，`begin_new_exec` 换账本并扔掉旧的，因此它是"不可回头点"，此后失败只能 `force_sig(SIGKILL)`；`exec` 复用 task 能省一份内存，shebang 脚本会多走一次装载
- 首批 VMA 由 `PT_LOAD` 决定权限、由 `PT_GNU_RELRO` 让 **ld.so**（不是内核）发起收紧的 `mprotect`、由 `arch_setup_additional_pages` 送 `[vdso]/[vvar]`
- ASLR 有五个独立落点（PIE 基址、`mmap_base`、legacy 基址、`brk`、栈顶），`randomize_va_space` 是**节点级且未 namespace 化**的 sysctl；`0x7f2a80000000` 这种整齐地址是 HotSpot 自己"预留-裁剪"的结果，不能据此判断 ASLR 关闭
- `JNI_CreateJavaVM` 才是 `-Xmx` 变成 VMA 的时刻；首次堆 `mprotect` 的长度等于 `-Xms`，是判断 commit 行为的最直接指纹；线程栈是"栈 + guard = 2 条 VMA"，且 glibc 线程缓存会让 `map_count` 在退出线程后不下降

---

# 第 4 章：第一次"开辟" - mmap/brk 与 VMA 插入

第 3 章结束时，Java 进程的地址空间已经存在，ELF 段已经就位，`-Xmx8g` 的那条 8 GiB `PROT_NONE` 预留也已经躺在 `maps` 里。这一章要回答的是"**开辟**"这个动作本身：一次 `mmap` 系统调用在内核里到底走了哪几道关卡、地址是从哪里挑出来的、`prot` 和 `flags` 的每一位各自买到什么、`brk` 和 `mmap` 有什么本质区别，以及最容易被误读的一件事——**开辟地址不等于占用内存**。

全文反复使用的基准数据集仍是第 2 章那台 `-Xmx8g`、`Threads: 312` 的 Java 11 进程。

## 4.1 do_mmap：一条 VMA 诞生要过的九道关卡

用户态的 `mmap(2)` 进入内核后，主干是 `ksys_mmap_pgoff` → `vm_mmap` → `do_mmap` → `mmap_region`。把它画成竖式调用链，每一步都对应一个"会失败的理由"：

```text
mmap(2)
 └─ ksys_mmap_pgoff      关卡1 参数校验：len 溢出 / 对齐
     └─ vm_mmap_pgoff
         ├─ acct_stack        关卡2 RLIMIT_STACK（仅栈）
         ├─ security_mmap_addr 关卡3 LSM（SELinux）拦截
         ├─ get_unmapped_area  关卡4 挑地址（见 4.2）
         └─ do_mmap
             └─ mmap_region  ── 以下持 mmap_lock 写锁 ──
                 ├─ call_mmap      关卡5 file-backed 走驱动
                 │                 的 mmap；6.x 起提前防 UAF
                 ├─ vma_merge      关卡6 能否并入邻居
                 ├─ map_count 检查  关卡7 超 max_map_count⇒ENOMEM
                 ├─ accountable_mapping
                 │  └─ __vm_enough_memory 关卡8(见 4.5)
                 ├─ vma_link       关卡9 插入区间树+链表
                 └─ vm_stat_account 记 total_vm / data_vm
             └─ 解锁并返回地址
                        页表：一条都不建
```

三点必须读出来：

**第一，`mmap_lock` 写锁贯穿关卡 4 之后（部分版本在挑地址前就加锁）直到插入完成。** 这意味着同一进程内所有 `mmap`、`munmap`、`mprotect`、`brk`、`madvise(MADV_DONTNEED)`、以及缺页路径上的 VMA 查找，全部在同一把锁上排队。JVM 的 Metaspace 扩容、CodeCache 补丁、DirectByteBuffer 分配、GC 的 uncommit，都会汇入这一条队列。第 11 章会用 `pmap -x`（它读 `maps` 要拿**读**锁）演示一个反直觉现场：一个观测命令本身就能把一个高并发 `mmap` 的 JVM 卡住。

**第二，关卡 6 的 `vma_merge` 决定了"`map_count` 会不会涨"。** 相邻、同权限、同匿名/文件属性、且中间没有 `mprotect` 造成差异的两段连续 `mmap`，内核会尝试合并成一条 VMA。这解释了一个常见困惑：为什么 `System.gc()` 后反复 uncommit/commit 同一区域，`wc -l /proc/<pid>/maps` 有时涨有时不涨。

**第三，也是最重要的一点：走完九道关卡，页表仍然一条都没建。** `mmap_region` 只做"记账 + 建 VMA 描述符"。第 3 章说过 PGD 在 `mm_init` 时就分配了，但中间级页表要等到第一次缺页（第 5 章）。所以一条 8 GiB 的 VMA 在内核里的即时成本，只是一个 `vm_area_struct`（约 200 字节量级）加区间树节点，与长度无关。

## 4.2 地址是挑出来的：top-down、gap 与 `MAP_FIXED`

关卡 4 里 `get_unmapped_area` 的行为取决于 `mm->get_unmapped_area` 这个函数指针。ELF 装载 64 位可执行文件时，内核把它设为 `arch_get_unmapped_area_topdown`；32 位或设置了 `legacy_va_layout` 时是 bottom-up 的 `arch_get_unmapped_area`。

```text
top-down（x86_64 默认）                     bottom-up（legacy）
高地址                                     高地址
 ┌──────────────┐ ← mm->mmap_base          ┌──────────────┐
 │  ↑ 从这往下长 │                           │              │
 │  mmap 区      │                           │   mmap 区     │
 │  （新块地址    │                           │   （从低往高   │
 │   越用越低）   │                           │    长）       │
 └──────────────┘                           └──────────────┘
        ↓ 空隙（gap）                             ↑ 空隙（gap）
 ┌──────────────┐ ← brk 顶                    ┌──────────────┐
 │  [heap]       │ → 往长                      │  [heap]       │
 ├──────────────┤                             ├──────────────┤
 │  .data/.bss   │                             │  .data/.bss   │
 ├──────────────┤                             ├──────────────┤
 │  ELF .text    │ ← PIE 基址                  │  ELF .text    │
 └──────────────┘                             └──────────────┘
低地址                                       低地址
```

挑选规则里有三个直接决定 JVM 行为的细节：

**（1）避让栈要用 `stack_guard_gap`。** 默认 256 页（1 MiB）。内核在 gap 里放新 VMA 时，会保持这个距离，不紧贴栈段。这是"堆栈相撞"事故的内核防线。但注意它的方向性：top-down 模式下大块预留从 `mmap_base` **向下**生长，而 `[heap]` 从低地址**向上**生长，两者从两端向中间逼近，`stack_guard_gap` 只能保护栈，保护不了"地址空间中间那片预留区互相挤压"。这正是第 6 章"地址空间碎片化"一节的核心机制——一旦 HotSpot 的某次 `VirtualSpace` 预留因为碎片失败，症状是 `There is not enough space` 而物理内存和 `Committed_AS` 都很宽裕。

**（2）THP 会放大 gap 并要求对齐。** 当透明大页可用时，内核对足够大的匿名映射会尝试给出 2 MiB 对齐的起点，实现方式是在挑选过程中引入额外 gap 并做对齐裁剪；不同内核版本对这个阈值和裁剪策略调整过多次，所以**不要按公式推算**。可靠判据只有一个：看 `smaps` 里该段的 `AnonHugePages` 是否非零、`Address` 尾号是否 `200000` 对齐。本例节点为 `madvise` 模式且 JVM 未开大页，后文 smaps 中 `AnonHugePages: 0`。

**（3）`MAP_FIXED` 是"我不在乎你有什么"。** 它跳过关卡 4（不挑地址），直接按指定地址插 VMA，**先无条件覆盖**该区间已有的任何映射——包括 JVM 自己的堆预留、ld.so 的 `lib` 段、甚至 `[vdso]`。JNI 库或注入 agent 里一句 `MAP_FIXED` 就能造成"堆莫名变短、符号莫名丢失"的诡异现场。4.17 起有 `MAP_FIXED_NOREPLACE`：地址照用，但冲突时返回 `-EEXIST` 而不是覆盖。**审计第三方 native 库时，`grep` 它有没有用 `MAP_FIXED`，是一项成本极低、命中率极高的检查。**

## 4.3 prot 与 flags：每一位到底买到了什么

HotSpot 的 `os::reserve_memory` 用的是这一组参数，值得逐位拆解：

```c
mmap(NULL, size, PROT_NONE,
     MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
```

| 参数位 | 内核落点（vm_flags） | 对 /proc 指标的影响 | Java 场景 |
| --- | --- | --- | --- |
| `PROT_NONE` | `VM_NONE`，但 `VM_MAYREAD/WRITE/EXEC` 仍置位 | 计入 `VmSize`；`VmData` 版本相关；不建页表 | 预留（reserve），后续靠 `mprotect` 提权 |
| `PROT_READ` | `VM_READ` | 同上 | 只读映射、RELRO 收紧后的段 |
| `PROT_WRITE` | `VM_WRITE`（`VM_MAYWRITE` 已在） | 同上 | commit 堆、Metaspace |
| `PROT_EXEC` | `VM_EXEC` | 计入 `exec_vm`（不进 `VmData`） | CodeCache、`.text` |
| `MAP_PRIVATE` | 非 `VM_SHARED` | 写时缺页走匿名/ COW | 匿名堆；文件段的私有映射 |
| `MAP_SHARED` | `VM_SHARED`、`VM_MAYSHARE` | 计入 `shared_vm` | `hsperfdata`、`-Xshare` 的 JSA/heap 归档、`FileChannel.map` |
| `MAP_ANONYMOUS` | 无 `struct file` | `RssAnon` 增长 | 堆、栈、Metaspace、CodeCache |
| `MAP_NORESERVE` | `VM_NORESERVE` | 可能不进 overcommit 记账（版本相关） | HotSpot 预留的默认选择 |
| `MAP_POPULATE` | 立即 `mm_populate` | `VmRSS` **当场**增长 | `-XX:+AlwaysPreTouch` 的部分实现路径 |
| `MAP_LOCKED` | `VM_LOCKED` | 受 `RLIMIT_MEMLOCK` | `mlockall` 类场景 |
| `MAP_FIXED` | 跳过挑地址，覆盖既有映射 | 可能凭空缩短邻居 VMA | 危险；改用 `MAP_FIXED_NOREPLACE` |

三个流传很广的误解，逐个纠正。

**误解一："`PROT_NONE` 只是不能访问，所以不算占用。"** `PROT_NONE` 的映射**完全计入 `VmSize`**——那条 8 GiB 预留就是 `VmSize` 21.7 GB 的最大单项。它不占的只是页表和物理页。而 `VM_MAY*` 位仍然置位，意味着这块地址将来可以合法地 `mprotect` 成读写；HotSpot 的 reserve/commit 双阶段模型能成立，靠的就是这个"当前权限与可提权限分离"的设计。反过来说，如果你在 `mprotect` 时被 `EACCES` 拒绝，通常是 `VM_MAY*` 被 `mprotect` 的历史调用削掉了，而不是权限位本身的问题。

**误解二："`MAP_NORESERVE` 保证不计入 `Committed_AS`。"** 方向是对的，但**不是无条件的**。是否把 `len` 计入提交账，由 `accountable_mapping()` 联合 `VM_NORESERVE`、是否 file-backed 的 `VM_SHARED`、以及 `sysctl_overcommit_memory` 三者决定；而这个判定函数在各内核版本里**被反复调整过**（历史上对 `PROT_NONE`、对只读共享映射的处理都变过）。所以任何关于"`MAP_NORESERVE` 就一定不记账"的断言都应该以本机实测为准——4.5 节给出实测方案。在不确定版本的集群里给出一条固定结论，比给出一条不精确的结论危险得多。

**误解三："给了 `PROT_READ|PROT_WRITE` 就真的有内存了。"** `mprotect` 提权只是改 VMA 的 `vm_flags` 和（将来）页表项的权限位，它本身不分配任何物理页。真正建 PTE 的只有三条路：`MAP_POPULATE`、`madvise` 的 `MADV_POPULATE_READ/WRITE`（5.14 起）、以及**真实的内存访问触发的缺页**。这解释了为什么 `-Xms` 设成 8g 之后必须等 GC 线程或应用真正写过堆，`VmRSS` 才会跟上。

`PROT_EXEC` 单独说一句：x86_64 Linux **并没有强制 W^X**（同一段映射既写又执行是允许的），但 SELinux 策略、`noexec` 挂载选项、CET/IBT 都可能收紧它。HotSpot 依赖的正是这种宽松：解释器和 JIT 需要往代码页里写指令，写完再执行，只要页能同时（或先后）拿到 `W` 与 `X`，这套流程就成立；一旦平台强制 W^X，就必须改成"可写别名映射 + 执行别名映射"的双映射方案。HotSpot 的 CodeCache 有一项特殊行为值得记住：JIT 在**补丁/反优化**时需要临时把代码页改成可写，写完再改回可执行，这会产生密集的 `mprotect` 调用——每一次都要拿 `mmap_lock` 写锁。这是第 11 章"CodeCache 抖动放大成全局停顿"的物理事件源。

## 4.4 brk：最古老的那条增长曲线

`brk` 是 Linux 上最朴素的堆：一个 `[heap]` VMA，起点在程序 `end` 之后，靠 `sys_brk` 把顶往上推或往下缩。

| 维度 | `brk` | `mmap` |
| --- | --- | --- |
| 地址 | 单一固定起点，只缩/扩顶 | 由 `get_unmapped_area` 任意挑 |
| VMA 条数 | 一条（合并 `map_count` 友好） | 每次一条（可被 `vma_merge` 合并） |
| 上调 | 扩展既有 VMA，用内核内部标志位（`vm_brk_flags`，各版本命名有差异） | 走完整九道关卡 |
| 下调 | `do_munmap`，**已触碰页立即释放** | `munmap` 同样立即释放 |
| 上限 | 受 `RLIMIT_DATA` 约束（历史受限，新版本已明显弱化） | 不看 `RLIMIT_DATA` |
| 与栈相撞 | grow 路径同样受 `stack_guard_gap` 保护 | 靠挑地址避让 |
| HotSpot 是否使用 | **几乎不用**（除 JNI/glibc） | 主要手段 |

`sys_brk` 上调时，内核会先看能否扩展紧邻高地址的那个 VMA（判断依据就是它的 `vm_flags` 等于 brk 专用标志集），能扩就扩、不新建；扩不动才新建一段。下调时走 `do_munmap`，被摘掉的页**当场回收**——这一点和 `mmap` 的匿名页语义一致，也解释了 glibc 的 `M_TRIM_THRESHOLD_` 为什么能真的把内存还给内核。

`expand_downwards` 是**另一条完全不同的路径**：它只在缺页处理里被调用，服务于 `VM_GROWSDOWN` 类 VMA（主栈），且每次扩展受 `RLIMIT_STACK` 约束。brk 的增长走的是"系统调用时就把 VMA 撑大"，缺页只负责填页表，两者不要混。

对 Java 进程，`brk` 的实际意义是**指纹**，不是内存来源：

- 你在第 1.1 节 strace 里看到的 `brk(0x55d3ab200000) = 0x55d3ab200000` 是**空操作**——入参等于返回值，说明 glibc 在探当前堆顶（`brk(0)` 语义的同族调用），没有开辟任何东西。
- 真正需要警惕的是 `cat /proc/<pid>/status` 里 `[heap]` 段（或 `smaps` 里那条 `rw-p ... 00:00 0` 且起点紧跟 `.bss` 的段）长到**数百 MB**。HotSpot 不走 brk，所以这条 VMA 上的每一个字节都来自 `malloc`/`sbrk` 系 native 代码——JNI 库、老 agent、JDK 内部的 `hsperfdata` 之外的 C 组件。它是"native 堆泄漏"最省事的定位入口。
- glibc 通过 brk 管理 main arena。四个调优变量直接影响 `[heap]` 的形状：`MALLOC_TOP_PAD_`（每次多圈多少，减少 `brk` 次数）、`M_TRIM_THRESHOLD_`（顶部空闲到多少才还）、`MALLOC_MMAP_THRESHOLD_`（超过就走 `mmap` 而非 brk，默认动态调整）、`MALLOC_ARENA_MAX`（arena 数量上限，容器里的经典止血开关）。第 12 章案例 3 会把这四个变量和一个 `map_count` 爆炸的现场对起来讲。

另外，第 1.1 节里那条 `mmap(NULL, 134217728, PROT_NONE, ...) = 0x7f2bb0000000` 后接 `munmap` 尾部 + `mprotect` 前 13 MiB 的组合，正是 `new_heap()` 为 malloc arena **用 `mmap` 而非 `brk` 圈地**的例子——因为它超过了 `MMAP_THRESHOLD` 且位于非 main arena。

## 4.5 overcommit：关卡 8 的三档闸门

`__vm_enough_memory` 是那个可能返回 `-ENOMEM` 的地方，行为由 `vm.overcommit_memory` 决定。

| 档位 | 名称 | 判定逻辑 | `Committed_AS` 的角色 |
| --- | --- | --- | --- |
| 0（默认） | `OVERCOMMIT_HEURISTIC` | 一般放行；对**极端**大的映射做启发式拒绝 | 仍在统计，但基本不作为闸门 |
| 1 | `OVERCOMMIT_ALWAYS` | 一律放行，直接 `return 0` | 只作统计口径，不参与判定 |
| 2 | `OVERCOMMIT_STRICT` | 与 `CommitLimit` 比较，超即 `-ENOMEM` | **唯一真正生效的闸门** |

`CommitLimit` 的计算式用中文写是：**总内存页数 × `overcommit_ratio` ÷ 100 ＋ 总交换页数**（`overcommit_ratio` 默认 50）。也就是说，把档位调到 2 之后，一台 32 GiB 内存、无 swap 的机器，全部进程的提交账加起来不能超过约 16 GiB——一个 `-Xmx8g` 的 JVM 光预留就可能吃掉一半额度，两个就起不来。

```text
__vm_enough_memory(len, accounting)
   │
   ├─ accountable_mapping 判定 accounting = false
   │     └─ 直接返回 0（本次不计账）
   │        ↑ 联合依赖 VM_NORESERVE / file-backed VM_SHARED
   │          / overcommit_memory；各版本调整过，务必实测
   │
   └─ accounting = true
         ├─ mode 1 ⇒ return 0
         ├─ mode 2 ⇒ len 累加进 Committed_AS
         │            若 Committed_AS > CommitLimit ⇒ -ENOMEM
         └─ mode 0 ⇒ 放行；过大时才按启发式拒绝
```

**必须实测，因为版本口径真的会变。** 下面这个探针可以在目标节点上把六格对照表打出来（三档 sysctl × 加/不加 `MAP_NORESERVE`）：

```c
/* probe.c：模拟 HotSpot 的 8 GiB PROT_NONE 预留 */
#include <sys/mman.h>
#include <stdio.h>

int main(void) {
    void *p = mmap(0, 8UL << 30, PROT_NONE,
                   MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
    printf("mmap -> %p\n", p);
    return 0;
}
```

```bash
grep -i Committed_AS /proc/meminfo     # 记录前值
gcc -O2 -o probe probe.c
./probe
grep -i Committed_AS /proc/meminfo     # 记录后值，做差
```

把 `MAP_NORESERVE` 去掉重跑一遍，再在 `kernel.overcommit_memory` 为 0/1/2 三档下各跑两遍，就得到一张属于**本机内核**的对照表。这张表比任何文章里的结论都可信，包括本节。

**实践结论只有一条，但很重要**：默认档位 0 下，`CommitLimit` 对大堆 JVM 形同虚设，**真正拦住它的不是 `mmap` 的 `-ENOMEM`，而是缺页时的物理内存分配**。也就是说，预留一定会成功，失败发生在第 5 章的缺页路径上——结局是 OOM killer 杀进程（`dmesg` 里有 `Killed process`），或者在容器里表现为 cgroup `memory.max` 触顶、K8s 报 `OOMKilled` 且 `lastState.terminated.reason` 是 `OOMKilled`。这条因果链是第 9 章（回收）与第 12 章（案例）反复回到的落点。也正因为如此，**在没实测过对照表的集群里改 `overcommit_memory` 为 2，会让一批原本正常启动的 JVM 直接起不来**——这是一个经典的"优化配置引发事故"入口。

## 4.6 四态三本账：reserve / commit / touch / uncommit

把第 1.2 节的三层模型翻译成"一次动作对三本账的影响"，这张表是后所有章节对账的坐标系。

| 阶段 | 系统调用 | `VmSize` | `VmData` | `VmRSS` | `Committed_AS` |
| --- | --- | --- | --- | --- | --- |
| reserve | `mmap(..., PROT_NONE, ...)` | 增加全长 | 版本相关 | 不变 | 通常不计（`NORESERVE`） |
| commit | `mprotect(..., RW)` | 不变 | 版本相关 | 不变 | 视 `accountable_mapping` 而定 |
| touch | 首次读写触发缺页 | 不变 | 不变 | **增加** | 不变 |
| uncommit | `madvise(DONTNEED)` ＋ `mprotect(NONE)` | 不变 | 版本相关 | **减少** | 若曾计账则减少 |

注意 `VmSize` 一栏：除了 reserve 和最终的 `munmap`，**其它任何动作都不会改变 `VmSize`**。这就是为什么一个疯狂 uncommit/commit 的 JVM，`VmSize` 曲线是一条直线，而 `VmRSS` 上下锯齿——很多人第一次看这条曲线会怀疑监控坏了。

拿基准数据集做一次真实的拆分。`RssAnon` 为 `8,902,164 kB`，逐段归因（数值来自同一份 `smaps` 分类求和）：

```text
堆 VMA（-Xmx8g 中已触碰部分）      8,276,480 kB
Metaspace + CompressedClassSpace     268,432 kB
CodeCache                            104,856 kB
GC 辅助结构 / 卡表 / 记忆集            96,256 kB
线程栈（312 线程已触碰部分）           78,336 kB
glibc arena / DirectByteBuffer / JNI  77,804 kB
                                   ----------
合计（= RssAnon，精确对齐）         8,902,164 kB
```

`VmData` 为 `12,024,816 kB`，能明确对上的部分：

```text
堆预留（8 GiB）                      8,388,608 kB
Metaspace + CCS 预留                 1,572,864 kB
CodeCache 预留                         245,760 kB
线程栈 312 × 1 MiB（-Xss1m）            319,488 kB
guard 段合计 312 × 64 kB                19,968 kB
                                   ----------
可对账小计                          10,546,688 kB
VmData − 小计                        1,478,128 kB ≈ 1.41 GiB
```

其中 `1,572,864 kB` 是 CompressedClassSpace（指针压缩开启且 `-Xmx` 小于 32 GB 时默认 1 GiB）加上 Metaspace 的 512 MiB 预留；`245,760 kB` 正好是 Java 11 的默认 `ReservedCodeCacheSize`（240 MiB）。**这两个数能对上默认值，本身就是"该预留出自 HotSpot 而非 JNI 库"的证据**——对账时这是最快的一条判据。

剩下的 1.41 GiB 归 glibc arena、Direct 内存、JNI 库自分配、以及若干 `PROT_NONE` 预留段——**这一项无法逐项对账**，因为不同内核对 `PROT_NONE` 匿名预留是否计入 `data_vm` 的归类规则不一致（`vm_stat_account` 按 `vm_flags` 分派，部分版本把它计入 `data_vm`，部分不计）。所以本文明确不给它一个精确解释，只给方法：**这类差额一律用 `jcmd <pid> VM.native_memory detail` 与 `smaps` 逐段归类交叉核对**，第 12 章案例 3 就是这套方法的完整演练。

顺带把两个差值记住，它们是后面所有推理的基础：`VmData − RssAnon = 3,122,652 kB`（约 3.0 GiB 是"开了地址、还没落物理页"），而 `VmSize − VmData` 的差额主要是 `.text` 等 file-backed 段与 `exec_vm` 的归类。

堆那段 VMA 的 `smaps` 长这样（省略若干与本文无关字段）：

```text
7f2a80000000-7f2c80000000 rw-p 00000000 00:00 0
Size:            8388608 kB
KernelPageSize:        4 kB
Rss:             8276480 kB
Anonymous:       8276480 kB
Private_Dirty:   8276480 kB
Shared_Clean:            0 kB
LazyFree:                0 kB
Swap:                    0 kB
THPeligible:             1
AnonHugePages:           0 kB
```

`Size − Rss = 112,128 kB` 就是"预留了但从未触碰"的堆尾。`AnonHugePages: 0` 对应本例 `THP=madvise` 且未开大页；`-XX:+UseLargePages` 的两条路线（hugetlb 与 THP）在第 8 章展开。

## 4.7 HotSpot 的虚拟内存抽象 ↔ 内核动作对照表

HotSpot 在 `os` 层之上还包了一层 `VirtualSpace` / `VirtualSpaceNode`（`memory/virtualSpace*`、`virtualSpaceNode`）。它不是内核概念，但每一个方法都能映射到确定的系统调用。

| HotSpot 动作 | 系统调用 | 内核动作 | /proc 指标变化 |
| --- | --- | --- | --- |
| `VirtualSpace::reserve` | `mmap(PROT_NONE, NORESERVE)` | 走九道关卡，建 VMA | `VmSize` 涨 |
| 预留过大后裁剪 | `munmap` 头/尾 | 删 VMA 或拆 VMA | `VmSize` 降、`map_count` 变 |
| `VirtualSpaceNode::commit` | `mprotect(RW)` | 改 `vm_flags` | `VmData` 视版本、`VmSize` 不变 |
| 应用首次写 | 缺页 | 建 PTE、分配页框 | `VmRSS`、`RssAnon` 涨 |
| `uncommit` | `madvise(DONTNEED)` ＋ `mprotect(NONE)` | 释放页、降权限 | `VmRSS` 降 |
| `-XX:+AlwaysPreTouch` | `MADV_POPULATE_WRITE` 或逐页写零 | 强制建 PTE | 启动期 `VmRSS` 直接到位 |
| `-XX:+UseLargePages` | `MAP_HUGETLB` 或 `MADV_HUGEPAGE` | 大页路线 | `HugePages_Rsvd`/`AnonHugePages` |
| 元空间分块 | `mmap` ＋ `mprotect` | `map_count` 增量来源 | `map_count` 涨 |

三条铁律，也是全文所有排障章节的记账原则：

**铁律一：一个 `VirtualSpaceNode` 可能被内核拆成多条 VMA。** 中间的 `mprotect` 权限变化、`munmap` 挖洞、`vma_merge` 失败，都会让"NMT 里的一段"在 `maps` 里对应"两三段"。所以拿 NMT 的 `Total reserved` 去减 `maps` 的总量，**必然不相等**，这不是 bug。

**铁律二：出现不一致时，先怀疑 `mprotect`/uncommit 半途失败。** `madvise` 成功但 `mprotect` 失败（或反之）会留下"页已归还、权限仍是 RW"或"权限已降、页还在驻留"的中间态。`-Xlog:gc+heap=debug` 只能告诉你 JVM 想不想 uncommit，告不了内核那一半——直接看 `smaps` 的 `Rss` 与 `Size` 是否背离，是唯一可靠的检查。

**铁律三：一切以 `smaps` 为准，NMT 只用于归因"是谁开的"。** `smaps` 是内核对物理事实的记录；NMT 是 JVM 自己记的小账，它看不到 JNI 库和 glibc 的行为，也不会覆盖未开跟踪的分配器。二者的正确用法是**交叉**，不是互相校验。

```bash
# 打开 NMT（启动期参数，或 attach 后 jcmd 动态开启）
java -XX:NativeMemoryTracking=detail -Xmx8g -jar app.jar
jcmd <pid> VM.native_memory summary   # 快速看分类总量
jcmd <pid> VM.native_memory detail    # 到调用点粒度
```

`summary` 里 `Java Heap` 一行的 `reserved` 应等于 `-Xmx`、`committed` 应等于 `-Xms`（`AlwaysPreTouch` 下 `reserved` 与 `committed` 相等，但 `VmRSS` 还取决于缺页是否真的发生完）。这两行是整个第 4 章最好用的自检：一旦 `committed` 明显小于 `-Xms`，说明 commit 阶段有 `mprotect` 失败，日志里通常已有 `Failed to commit`。

**本章要点：**

- `do_mmap` 的九道关卡里，只有"挑地址、能否合并、`map_count` 上限、overcommit 记账"四道是真正的失败点；走完全部关卡**一条页表都不会建**，8 GiB VMA 的即时成本只是一个 VMA 描述符
- `mmap_lock` 写锁贯穿 `mmap/munmap/mprotect/brk/madvise`，同进程内全部串行；CodeCache 补丁的 `mprotect` 抖动会汇入这把锁（第 11 章）
- x86_64 默认 top-down：预留从 `mmap_base` 向下生长、`[heap]` 向上生长，`stack_guard_gap` 只保护栈不保护中间预留区，因此"碎片化导致预留失败"是结构性风险（4.2 已展开，第 11 章给出观测手段）
- `MAP_FIXED` 无条件覆盖既有映射，`MAP_FIXED_NOREPLACE`（4.17 起）冲突才报错；审计 native 库先看有没有用 `MAP_FIXED`
- `PROT_NONE` 全额计入 `VmSize` 且保留 `VM_MAY*` 提权能力——这是 HotSpot reserve/commit 模型的内核基础；`mprotect(RW)` 本身不分配物理页
- `overcommit_memory=2` 时 `CommitLimit` = 总内存 × ratio ÷ 100 ＋ swap，才成为真闸门；默认档位 0 下大堆 JVM 的失败点是**缺页**而非 `mmap`（容器里表现为 `OOMKilled`）；改 sysctl 前先用 `probe.c` 打本机对照表
- 四态对账（reserve/commit/touch/uncommit）里只有 reserve 动 `VmSize`、只有 touch 动 `VmRSS`；NMT 与 `smaps` 不相等是常态，交叉归因才是正确用法

---
