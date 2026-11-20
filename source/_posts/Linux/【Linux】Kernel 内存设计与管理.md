---
title: Linux 内核内存设计与管理体系：从物理页、页表到回收与 OOM
date: 2026-10-09 10:00:00
categories: [操作系统]
tags: [Linux, 内核, 内存, 性能优化, SRE]
---

> 姊妹篇《Linux 进程内存生命周期管理》讲的是**虚拟地址**的一生：`mm_struct`、VMA、`mmap` 与 `munmap`。本篇讲的是**物理内存**的一生：一页内存如何被伙伴系统交出、如何被 SLUB 切碎、如何在 page cache 里被复用、如何在 LRU 上变冷、如何在回收与 OOM 之间被夺走。两篇合起来，才是内核 MM 的完整闭环。
>
> 口径说明：全文以 Linux 5.10 / 5.15 / 6.6 LTS 为基准，涉及版本差异处逐条标注；所有机制描述以内核源码路径为准，不确定处明确写"以本机源码为准"，不做经验性断言。

---

# 第 1 章：引言 - 内核内存管理要回答的三个问题

## 1.1 三份账，一条链

一个 Linux 系统无论跑多少进程、加载多少驱动，内存管理子系统自始至终只在回答三个问题：

1. **放得下吗**——分配侧。有人要一页（或连续 2 的 n 次方页）物理内存，内核手里有没有？在哪里？给不给得起？
2. **找得到吗**——映射侧。分配到的物理页要能被再次访问到：虚拟地址到物理地址的翻译（页表、TLB）、以及反方向"这张页被谁映射了"（反向映射 rmap）。
3. **还得掉吗**——回收侧。内存不够时，夺走谁的？怎么判断一页"可以还"？还不掉时怎么办（OOM）？

日常运维里绝大多数"内存问题"都能对号入座到这三份账上：

```text
放得下吗   → 分配失败、高阶页拿不到、碎片、watermark 击穿
找得到吗   → 页表膨胀、TLB miss、vmalloc 区域性能差
还得掉吗   → kswapd 忙、direct reclaim 卡顿、swap 抖动、OOM Kill
```

> **关键认知**：`free` 低不是问题，`可用`低才是问题；而"可用"这个概念本身就是三份账交织的结果——page cache 算不算可用、memcg 限额算不算账、脏页多久能洗成干净页，全部影响同一个数字。单看 `/proc/meminfo` 的 `MemFree` 或 `MemAvailable` 做判断，是内存排障中最常见的归因错误。

## 1.2 全景：一页内存的生命周期

先把后续 16 章的内容压进一张图。一页物理内存从固件报告给内核，到最终被释放或夺走，走的是这样一条链：

```text
                   一次分配请求
                       │
                       ▼
   ┌──────────────────────────────┐
   │  放得下吗？分配侧            │
   │  node/zone/order 水位检查    │
   └──────────────────────────────┘
                       │
                       │ 交出 struct page
                       ▼
   ┌──────────────────────────────┐
   │  找得到吗？映射侧            │
   │  页表 TLB 反向映射 rmap      │
   └──────────────────────────────┘
                       │
                       │ 访问变冷，需要腾地方
                       ▼
   ┌──────────────────────────────┐
   │  还得掉吗？回收侧            │
   │  LRU shrink memcg OOM        │
   └──────────────────────────────┘
```

对应到章节：第 2 章讲物理内存的骨架（node/zone/page）；第 3 章讲映射侧；第 4-7 章讲分配侧的快慢路径与缺页下游；第 8-12 章讲页的复用（cache）、变脏（回写）、变冷（LRU 回收）与被换出（swap）；第 13-14 章讲账本与强制夺走（memcg、OOM）；第 15-16 章讲 NUMA 与大页两个横切维度；第 17 章把所有观测串成因果链。

## 1.3 与既有姊妹篇的分工

本仓库已有几篇内存相关文章，为避免混淆，分工如下：

| 文章 | 视角 | 本篇如何衔接 |
| --- | --- | --- |
| 进程内存生命周期管理 | 虚拟地址侧：VMA、mmap、缺页处理 | 本篇从缺页的**下游**接手：fault 决定要一页物理内存之后发生什么 |
| 系统内存分配应用分析 | 分配器侧：glibc malloc、JVM 堆 | 本篇讲分配器之下**内核的账**：SLUB、页分配器、回收 |
| 系统内核基础结构分析 | 全子系统概览 | 本篇是 MM 单子系统**纵深 + 运维证据链** |

第 7 章会明确标注两篇的接缝：一次缺页在内核里如何从 `do_fault` 走到 `alloc_pages`，进程侧细节不再重复。

## 1.4 版本口径与阅读地图

本文涉及的版本敏感点，一次性列清（正文各章还会就地重申）：

```text
5.10   process_madvise 可用；radix tree 已被 xarray 取代
5.15   DAMON 框架合入（DAMON_RECLAIM 稍后）
6.1    Maple Tree 取代红黑树 VMA 管理；MGLRU 合入
6.4    MAX_ORDER 语义调整为 NR_PAGE_ORDERS（buddyinfo 列数即上限）
6.5    per-VMA locks 实验性合入（真实符号 lock_vma_under_rcu）
6.6    CPU 调度 EEVDF（见 CPU 篇，不影响本篇）
```

阅读地图（按问题找章节）：

| 症状 | 直奔章节 |
| --- | --- |
| 分配失败 / 高阶页拿不到 | 第 4、5 章 |
| slab 内存异常高 | 第 6 章 |
| 缺页延迟毛刺 | 第 7 章（及姊妹篇） |
| cache 命中差 / 预读异常 | 第 8 章 |
| 写文件卡顿、脏页节流 | 第 9 章 |
| kswapd 高 CPU、direct reclaim | 第 10、11 章 |
| swap 抖动 | 第 12 章 |
| 容器被限流 / OOMKilled | 第 13、14 章 |
| 跨 NUMA 延迟 | 第 15 章 |
| 大页相关问题 | 第 16 章 |
| 不知道从哪查起 | 第 17 章 |

**本章要点：**

- 内核内存管理只有三份账：分配、映射、回收；一切症状先对号入座。
- `MemFree`/`MemAvailable` 是多本账交织的结果，孤立看单个数字必然误判。
- 本篇讲物理页的一生，与姊妹篇（虚拟地址的一生）在缺页处接缝。
- 版本差异集中在 6.x 一代（Maple Tree、MGLRU、NR_PAGE_ORDERS），5.10/5.15 与 6.6 的口径必须分开说。

---

# 第 2 章：物理内存的骨架 - node、zone、page 与 struct page

## 2.1 从固件表到 memblock，再到伙伴系统

内核启动早期，物理内存的信息来自固件：传统 BIOS 的 e820（UEFI 下是 EFI Memory Map）。这些原始条目描述了"哪段物理地址是可用 RAM、哪段被固件/设备占走"。

拿到原始地图后，内核先用自己的早期分配器 **memblock** 管理内存（`mm/memblock.c`）：

```text
固件表(e820/EFI)
   → memblock.memory   全部可用物理段
   → memblock.reserved 已被占用段(内核代码/数据/早期分配)
   → free_area_init_nodes()
   → 每个 node/zone 的 free_area 挂上伙伴页
   → memblock 使命结束，伙伴系统接管
```

dmesg 里那一行熟悉的启动信息，就是这条链的终点：

```text
Memory: 32652584K/33550304K available (14340K kernel code,
        2625K rwdata, 4128K rodata, 2048K init, ...)
```

分子减分母：约 898 MB 的差额 = 内核镜像 + `struct page` 数组 + memblock 保留，这部分**永远不会出现在 `free` 里**。理解这一点，才能理解为什么 32 GB 的机器 `free` 上限从来不是 32 GB。

## 2.2 四级切分：node、zone、pageblock、order

物理内存自上而下被切成四级，每一级解决一个不同的问题：

```text
物理内存
 └─ node（NUMA 节点）           问题：距离不同，代价不同
     └─ zone（DMA/DMA32/NORMAL/MOVABLE）  问题：能力不同，不能混用
         └─ pageblock（默认 2 MiB）    问题：同类页聚块，便于整理
             └─ order-0 页（4 KiB）        问题：统一分配粒度
```

- **node**：NUMA 拓扑，来自固件 SRAT 表，每个 node 有自己的距离矩阵（`nm System Node: ...`、`/sys/devices/system/node/node*/distance`）。
- **zone**：同一 node 内按"物理地址能力"划分。x86-64 典型为 `DMA`（低 16 MB，遗留 ISA）、`DMA32`（低 4 GB，32 位设备可达）、`NORMAL`（主力）、`MOVABLE`（只放可迁移页，服务于内存热插拔与 CMA）。`HIGHMEM` 只存在于 32 位内核；`ZONE_DEVICE` 用于 pmem/GPU 这类"像内存的持久设备"（`mm/sparsemem.c`、`CONFIG_ZONE_DEVICE`）。
- **pageblock**：`pageblock_order` 个连续页组成的块（有 THP 的 x86-64 上 `pageblock_order` 为 9，即 2 MiB），是迁移类型（migratetype）归属的基本单位——这决定了第 4 章碎片问题的形成机制。
- **order**：伙伴系统按 2 的 n 次方页组织空闲链，order-0 即单页。

> **关键认知**：zone 划分的本质是**约束交换**。老设备只能访问低地址，所以必须留一批内存给它；而可迁移页被集中到 MOVABLE，是为了让"整块内存可以腾空下线"。zone 不是性能优化，是兼容性与管理性的妥协产物。

## 2.3 struct page：每页 64 字节的影子成本

每个 4 KiB 物理页在内核里都有一个描述符 `struct page`（`include/linux/mm_types.h`），x86-64 典型大小 **64 字节**。影子成本约等于物理内存的 1/64（1.56%）——32 GB 内存仅"户口本"就吃约 512 MB。

它的核心是成员复用（union）加一组标志位：

```c
struct page {
    unsigned long flags;
        // 页状态位：PG_locked / PG_dirty / PG_lru / PG_active /
        // PG_slab / PG_buddy / PG_workingset 等
    union {
        struct {                // 被分配给用户的匿名页/映射页
            atomic_t _mapcount; // 被多少 PTE 映射，-1 表示无人映射
            atomic_t _refcount; // 引用计数，0 表示可释放
        };
        struct {                // slab 页（第 6 章）
            struct kmem_cache *slab_cache;
            void *freelist;     // 已释放对象链
            unsigned long inuse;
        };
        struct list_head buddy_list;   // 伙伴空闲链（PG_buddy）
        struct address_space *mapping; // page cache：属于哪个文件的
        unsigned long virtual;         // 内核地址（直接映射）
    };
    /* 还有 index（文件内页偏移）、lru（在 LRU 链上的挂点）等 */
};
```

三个设计要点：

1. **union 省内存**：一页不可能同时是 slab 页、伙伴空闲页和 page cache 页，所以字段叠用。代价是读代码时必须先问"这页现在是什么身份"——答案在 `flags` 里。
2. **双计数体系**：`_refcount` 管生命周期（还有没人持有），`_mapcount` 管映射（回收时要不要扫页表）。引用归零走 `__free_pages`，映射归零但引用还在，页仍可存在。
3. **lru 字段是回收的钩子**：页进入 LRU 链（第 10 章）靠的就是这个 `struct list_head`，`PG_active`/`PG_workingset` 决定它在 inactive 还是 active 链上。

## 2.4 folio：复合页时代的"页头"抽象

大页、swap cache 等场景需要**复合页**（compound page）：多个物理页捆在一起，只有头页（head page）的元信息有效，尾页的 `flags` 里有 `PG_tail` 标记。过去代码里到处是 `compound_head(page)` 手工取头页的样板。

`folio`（`include/linux/mm.h`）把这个约定固化成类型：**folio 保证自己指向头页**，大小由 `folio_order()` 描述。5.x 后期到 6.x，`mm/` 与 `fs/` 大量接口从 `page *` 迁移到 `folio *`。运维视角的变化：

```text
旧：page 4 KiB 为绝对单位，THP 是特殊存在
新：页操作以 folio 为单位，2 MiB THP 在账目上就是一个 folio
```

这解释了 6.x 的 `/proc/vmstat` 里出现按 folio 计数的项，与 5.10 按页计数**口径不同**，做跨版本基线对比时不能直接相减（以本机 `mm/vmstat.c` 为准）。

## 2.5 spanned、present、managed：三种"大小"对不上是常态

`/proc/zoneinfo` 里每个 zone 报三个数，关系恒为 `spanned` ≥ `present` ≥ `managed`：

```text
spanned  : 从最低 pfn 到最高 pfn 的地址跨度（含空洞）
present  : 真实在线、有 struct page 的页（空洞里没有）
managed  : 真正可以分配给伙伴系统的页（再扣掉保留与不可用）
```

差值来源：固件保留段、内核镜像与 `struct page` 数组自身、内存热插拔未上线的 section、页表检查保留等。排障时如果一个 zone 的 `managed` 与 `present` 差距异常大，先查 `memmap=` 启动参数与 KASAN/page_report 类调试选项，而不是怀疑"内存丢了"。

## 2.6 page_ext：第二层影子账本

`struct page` 之外还有一层可选的**影子数组** `page_ext`（`mm/page_ext.c`）：`page_owner=on`（记录每页的分配调用栈）、`KASAN`、`PAGE_TABLE_CHECK`（6.4 前后合入，以本机源码为准）等调试特性，都会按物理页追加一份元数据。

运维含义：开 `page_owner` 的云主机，内核内存开销会明显高于对照组。`page_owner` 的具体每项开销随配置与版本变化，**不要背固定数字**，用第 17 章的方法实测前后差值。关闭方式在内核 cmdline（`page_owner.off`）或启动参数里不启用。

## 2.7 观测入口：zoneinfo、buddyinfo、pagetypeinfo

```bash
cat /proc/zoneinfo          # 每 zone 的 managed/min/low/high/现存量
cat /proc/buddyinfo         # 每 zone 每 order 的空闲块数
cat /proc/pagetypeinfo      # 每 migratetype 每 order 的块分布
ls /sys/devices/system/node/node0/memory_block/   # 热插拔 section
```

`/proc/buddyinfo` 的典型输出与读法：

```text
Node 0, zone Normal 28 15 23 14 11 7 5 3 1 0 2
                    o0 o1 o2 o3 o4 o5 o6 o7 o8 o9 o10
```

列数 = order 上限（版本相关，6.4 起由 `NR_PAGE_ORDERS` 决定，典型 11 列）。健康的通用服务器：低阶页常年充裕；`o4`（1 MiB）以上归零且持续为 0，说明碎片化严重——THP、大块 kmalloc、CMA 都会失败（第 5 章）。

**本章要点：**

- 物理内存骨架四级：node（距离）→ zone（能力）→ pageblock（迁移单位）→ order（分配粒度）。
- `struct page` 64 字节/页，影子成本约 1/64；union 叠字段，身份看 `flags`。
- 双计数：`_refcount` 管生死，`_mapcount` 管映射；`lru` 字段是回收入口。
- folio 是复合页的"头页保证"抽象，6.x 统计口径由页向 folio 迁移，跨版本对比要小心。
- `spanned/present/managed` 三者对不上是常态；`page_ext` 类调试特性是隐藏的第二层开销。

---

# 第 3 章：地址与物理之间的桥 - 页表、TLB 与 vmalloc

## 3.1 页表层级与每级覆盖范围

x86-64 默认 4 级页表（5 级 LA57 需硬件与配置支持，`CONFIG_X86_5LEVEL`），自上而下逐级把虚拟地址切成索引：

```text
虚拟地址 48 位(4 级)切分：
 [ pgd 9b ][ pud 9b ][ pmd 9b ][ pte 9b ][ 页内偏移 12b ]

每级表 512 项，每项 8 字节，一张表 4 KiB：
 PGD : 1 张表      覆盖全部 256 TiB
 PUD : 每项        覆盖 1 GiB
 PMD : 每项        覆盖 2 MiB   ← THP 落点：PMD 直接指向 2 MiB 物理块
 PTE : 每项        覆盖 4 KiB   ← 普通页落点
```

三种映射粒度对应三种硬件行为：4 KiB 走满 4 级；2 MiB 在大页时省略 PTE 层（PMD 级直接映射）；1 GiB 在 PUD 级直接映射。**大页的本质收益不是"快"，而是"页表项数量与 TLB 覆盖范围的比例改善"**——这一点在第 16 章用数字拆开算。

## 3.2 页表本身也吃物理内存

页表项占的是真实物理页，账目在进程侧可见：

```bash
grep VmPTE /proc/<pid>/status      # 该进程页表页合计
grep -i Rss /proc/<pid>/smaps      # 页表页也计入部分 smaps 口径
```

粗略规律：4 KiB 映射下，每 **512 页（2 MiB）用户内存需要 1 页（4 KiB）PTE 表**，页表开销约 0.2%；但若一个 8 GiB 堆全部打散成 4 KiB 映射，PTE 页合计约 16 MiB/进程。6.x 的 memcg v2 账本 `memory.stat` 中出现 `anon`、`slab`、`pagetable`（内核栈、页表计费增强，具体字段以本机内核为准）等分类——这解释了"RSS 正常但 cgroup 逼近 limit"的一类案例（第 13 章）。

> **关键认知**：巨量 VMA + 巨量小页 = 页表膨胀；页表膨胀同时抬高**内存账**、**缺页成本**（分配页表页本身要分配内存）和 **TLB 压力**。三者是同一个根因的三个症状，分开优化必然失败。

## 3.3 直接映射、vmalloc 与 fixmap：内核自己的三种地址

内核看到的物理内存有三种地址形态（`arch/x86/include/asm/page_64_types.h`、`mm/vmalloc.c`）：

```text
直接映射 linear map : [page_offset_base .. +全部RAM]
                      物理连续 ⇒ 虚拟连续，零页表成本，最快
vmalloc 区          : 虚拟连续，物理可散
                      每次访问可能 TLB miss + 建表成本
fixmap/iomap        : 固定槽位，早启动映射设备/MMIO
                      （ioremap 独立区，细节从版本源码）
```

`kmalloc` 小对象走直接映射；大块连续物理内存或"连续虚拟即可"的缓冲走 `vmalloc`。vmalloc 的隐性代价：

```text
1. vmalloc 区页表由内核态构建，分配路径更长（vmap_page_range）
2. 每次 vfree 要等待所有 CPU 的 RCU 宽限期（延迟释放），
   高频 alloc/free 会看到 vmap_lazy_free 堆积
3. TLB 覆盖分散，顺序扫描 vmalloc 区比直接映射慢
```

排障时用 `/proc/vmallocinfo` 看哪个模块/驱动占了多少 vmalloc，怀疑"内核内存异常但 slab 不高"时这里是第三个嫌疑账本（前两个是 page 分配与页表）。

## 3.4 TLB shootdown 与批处理

硬件页表翻译靠 TLB 缓存。难点从来不是查询，而是**失效**：一个进程在 CPU A 上解除映射，CPU B/C/D 上缓存的旧翻译必须同步作废——这就是 TLB shootdown：

```text
unmap 一方:
  zap_pte_range() → mmu_gather 收集待失效区间
  → tlb_flush_pipeline / tlb_flush_mmap
  → 对其他在用该 mm 的 CPU 发 IPI(INVLPG / invlrb)
```

内核的缓解手段就是"攒批"：`mmu_gather`（`include/asm-generic/tlb.h`）把一次 `munmap`/`exit_mmap` 拆出的成百上千个失效区间合并成少量 flush，减少 IPI 次数。x86 的 PCID/ASID 让换页表不必全局刷；AMD 的 `INVLPGB` 广播失效（较新硬件，内核支持以版本为准）。

TLB 问题的现场证据（第 17 章展开命令细节）：

```bash
perf stat -e dTLB-load-misses,dTLB-store-misses -p <pid> -- sleep 5
perf record -e tlb:tlb_flush -a -- sleep 5    # flush 事件密度
```

`exit_mmap` 阶段集中 shootdown 的典型症状：进程退出时出现 10-50 ms 的毛刺，且 CPU 数越多、映射越大毛刺越明显——这是 IPI 串行化等待，不是"内存没释放"。

## 3.5 PCID 与 KPTI：翻译的"身份成本"

2018 年 Meltdown 缓解引入 KPTI（内核页表隔离），每次系统调用进出都要切换页表；早期实现下系统调用密集负载性能损失可达两位数百分比。PCID（进程上下文标识符）把页表基址切换从"全刷 TLB"降级为"按 ID 选择性失效"，之后成本大幅下降；新硬件（如带硬件隔离位的平台）进一步免掉内核态/用户态页表切换。**结论**：排障时在虚拟化、容器、安全加固叠加的环境里，`syscall` 延迟基线本身受页表隔离策略影响，对照宿主机参数再下结论。

## 3.6 映射侧的观测口径汇总

| 指标 | 来源 | 异常含义 |
| --- | --- | --- |
| VmPTE | /proc/pid/status | 页表膨胀，小页映射过多 |
| vmalloc 用量 | /proc/vmallocinfo | 某驱动/模块持有大量内核虚拟区 |
| dTLB miss | perf 硬件事件 | 访问局部性差或大页缺位 |
| tlb_flush | perf tracepoint | 频繁 unmap/exit 引发 shootdown |
| nr_free_table_pages | /proc/vmstat（以版本为准） | 页表页释放积压 |

**本章要点：**

- 页表是树，每级 512 项；PMD 大页省略 PTE 层，收益在项数与 TLB 覆盖率。
- 页表吃真实物理内存并计入进程与部分 cgroup 账本；页表膨胀、缺页变慢、TLB 压力同根同源。
- 内核自身地址分直接映射、vmalloc、fixmap/iomap 三种，vmalloc 的代价是页表、RCU 延迟释放与 TLB。
- TLB shootdown 靠 IPI，内核用 mmu_gather 攒批缓解；PCID/KPTI 决定系统调用切换翻译的成本基线。

---

# 第 4 章：伙伴系统快路径 - order、watermark 与每 CPU 页批

## 4.1 阶与块：空闲页的组织方式

伙伴系统（`mm/page_alloc.c`）把每个 zone 的空闲页按连续性组织：

```text
free_area[MAX_ORDER 或 NR_PAGE_ORDERS][MIGRATE_TYPES]
   每个槽位 = 一条按 order 排列的空闲块链表
   order-n 的一块 = 2^n 个物理连续页，其"伙伴"地址 = 基址 XOR (2^n 页)
```

释放 order-0 页时，若同 zone 同 order 的伙伴也在空闲链上（且 migratetype 一致），合并成高一阶，递归向上——这就是"伙伴"之名的由来。

两个必须记住的边界：

1. **order 上限**：典型 4 MiB（order-10，列数 11）。`MAX_ORDER` 的语义在 6.4 起改为 `NR_PAGE_ORDERS` 表达，buddyinfo 的列数就是真相。
2. **`PAGE_ALLOC_COSTLY_ORDER` = 3**：order > 3 的分配失败**不会触发 OOM**，而是直接返回 `-ENOMEM`。所以"高阶分配失败但 dmesg 没有 OOM 日志"是正常设计，不是日志丢了——这是碎片问题常被漏诊的关键原因。

## 4.2 三条水位线：min、low、high

每个 zone 维护三条水位（`/proc/zoneinfo` 中每 zone 的 `min/low/high` 行）：

```text
free_pages
 ───────────────────── high  kswapd 睡到这里才回来
 ───────────────────── low   低于此唤醒 kswapd
 ───────────────────── min   普通分配必须留底
                         （atomic 折半插队 HARDER）
 ───────────────────── 0
```

- 高于 `low`：快路径分配，皆大欢喜。
- 低于 `low`：唤醒 `kswapd` 后台回收；分配仍走快路径。
- 低于 `min`：普通（可睡眠）分配转入慢路径（direct reclaim，第 5 章）；atomic 分配靠 `ALLOC_HARDER` 把 min 折半继续插队。

水位间距由 `vm.watermark_scale_factor`（万分数）控制，`gap = managed × factor / 10000`；各版本对每区最小间距有量化常量（`WMARK_QUANTUM`，取值随版本演进，**不背固定数字**，以 `mm/page_alloc.c` 为准）。调大 `watermark_scale_factor` 让 kswapd 更早醒、回收更多余量，代价是 `MemFree` 基线更高、cache 被多回收——这是"kswapd 高 CPU"与"偶发卡顿"之间的经典权衡。

## 4.3 快路径调用链

一次 `alloc_pages(GFP_KERNEL, 0)` 的快路径：

```text
alloc_pages / __alloc_pages_nodemask
 └─ get_page_from_freelist          逐 node/zone 尝试
     └─ rmqueue
         └─ rmqueue_pcplist         先取每 CPU 批缓存
             └─ rmqueue_bulk        批缓存空了：从伙伴一次补一批
         └─ __rmqueue_smallest      批缓存也没有：找最小够用的 order
             └─ expand              大块分裂
```

`GFP` 标志如何变成行为差异，是理解"为什么这次分配能过而那次不能"的核心：

| 标志组合 | 关键位 | 行为差异 |
| --- | --- | --- |
| GFP_KERNEL | 可睡眠、可回收、可写回 | 标准路径，慢但成功率高 |
| GFP_ATOMIC | 不可睡眠 | 无 reclaim 兜底，只能靠水位打折与应急预留 |
| GFP_DMA32 / __GFP_DMA | 限定 zone | 低地址受限，更容易失败 |
| __GFP_NOWARN | 静默 | 失败不打印——排障时先想到日志被静音 |
| __GFP_RETRY_MAYFAIL | 可放弃重试 | 允许失败返回而非强行回收 |

## 4.4 每 CPU 批缓存（pcplist）与它的观测陷阱

快路径为了避开 zone 自旋锁，把页先成批搬到每 CPU 的 `pagelist` 缓存（`rmqueue_bulk` 一次取一批，上限常量 `PAGELIST_BATCH_SIZE`，页数量级约百来页，精确值以 `mm/page_alloc.c` 为准）。

由此产生一个必须提前知道的观测陷阱：

```text
zone->free_pages  : 包含 pcplist 里的页（仍然记账为空闲）
/proc/buddyinfo   : 只统计挂在伙伴 free_list 上的块
⇒ 两者对不上是设计使然，不是 bug
```

高并发小分配时，pcplist 会掩盖伙伴侧的真实紧张程度；反过来，CPU 局部缓存大量空闲页而全局水位告急时，`allocstall` 也会先出现。用 `buddyinfo` 与 `zoneinfo` 的 `free` 行交叉比对，才能还原真实分布。

## 4.5 分裂（expand）与大块去哪了

`__rmqueue_smallest` 从 order-4 往低扫，找到第一个非空链：若只有 order-6 空闲而请求是 order-4，调用 `expand` 连续分裂两次，每次留下的一半重新挂回低一阶空闲链。

```text
order-6 块(64 页) 分裂 → order-5(32) + order-5(32)
                      → order-4(16) 交付，order-4(16) 归链
```

含义：**空闲总量没变，高阶块变少**。`buddyinfo` 右端（高阶）列被持续分裂消耗、且回收还不上（伙伴页 migratetype 不一致无法合并），就是碎片的形成过程。第 5 章讲它如何恶化、compaction 如何补救。

## 4.6 插队权：ALLOC_HARDER、ALLOC_HIGH 与应急预留

快路径里 `get_page_from_freelist` 按 `alloc_flags` 决定能用水位以下的多少内存（`mm/page_alloc.c` 的 `__zone_watermark_ok`）：

```text
ALLOC_HARDER (atomic/中断上下文) : min 水位要求折半
ALLOC_HIGH   (__GFP_HIGH)        : 允许动用应急预留
ALLOC_MEMALLOC (PF_MEMALLOC)     : 内存回收进行中借页（网络栈等），
                                   只碰 memalloc 预留池
ALLOC_NO_WATERMARKS              : 仅 memalloc 保存恢复等极端场景
```

> **关键认知**：所谓"atomic 预留"不是一笔额外内存，而是**同一池子里划出的最低消费红线**。长期靠 `ALLOC_HARDER` 透支的 zone，表现为 `zoneinfo` 里 `free` 低于 `min` 仍未 OOM，但 `pgalloc_*` 增长伴随延迟毛刺——系统正在花应急存款，这是"下次可能击穿"的预警信号，而不是"没问题"。

## 4.7 migratetype 回退：碎片的第一推动力

每个 pageblock 有 migratetype（`MOVABLE`/`UNRECLAIMABLE`/`RECLAIMABLE`/`HIGHATOMIC`/`CMA`/`ISOLATETYPE`）。理想情况是"不可移动页住不可移动块，可移动页住可移动块"，将来整理时只需搬可移动的。现实是块会耗尽：

```text
请求 MOVABLE，MOVABLE 链空
 → fallback 矩阵允许借其他类型的块（mm/page_alloc.c fallbacks）
 → 借来后整块转换类型；若原块里有混居页，留下"污染"
 → 污染块 = 可移动页与不可移动页混住 → compaction 搬不动 → 碎片固化
```

这是 `pagetypeinfo` 存在的意义：按类型看块纯度。`Unmovable Free` 块很多而 `Movable` 全被占，后续任何大页/THP 分配都会先失败。缓解方向：保证 MOVABLE zone 足够、避免内核长期钉住可移动页（`mlock`、pin_user_pages 滥用）、必要时启用 `CONFIG_COMPACTION` 下的主动整理（第 5 章）。

## 4.8 快路径的观测口径

```bash
grep -E 'pgalloc|allocstall|compact|thp' /proc/vmstat
cat /proc/buddyinfo
cat /proc/zoneinfo | head -40
```

读法速记：

```text
pgalloc_*        分配总量（含快路径），增速≈业务流量
allocstall_*     慢路径进入次数——快路径失败的直接证据
compact_*        整理成败（第 5 章细看）
buddyinfo 高阶列 持续为 0 → 碎片已影响大块分配
zoneinfo free vs min  长期贴地 → 靠插队权活着
```

**本章要点：**

- 伙伴系统按 order + migratetype 二维组织空闲块；分裂与合并是它的两个基本动作。
- 三条水位定义三种世界：快路径、kswapd 唤醒、direct reclaim；atomic 的插队权是把 min 折半。
- order > 3 的失败不触发 OOM，只回 `-ENOMEM`——"没有 OOM 日志"不等于"分配成功"。
- pcplist 让 buddyinfo 与 zone 记账天然对不上；交叉比对才有真相。
- migratetype 回退造成的块污染，是碎片从现象固化为结构问题的第一推动力。

---

# 第 5 章：伙伴系统慢路径 - kswapd、direct reclaim、compaction 与碎片

## 5.1 怎么进入慢路径

快路径（第 4 章）拿不到页，`__alloc_pages_slowpath` 接管。注意决策顺序——**回收和整理都在分配者自己身上发生**：

```text
get_page_from_freelist(low 水位) 失败
 → wake_all_kswapds               叫醒后台回收
 → 放宽条件再试一次快路径
 → __alloc_pages_direct_reclaim   自己回收
 → __alloc_pages_direct_compact   自己整理碎片
 → 重试循环，priority 逐步收紧
 → order≤3 仍失败 → OOM 兜底（第 14 章）
 → order>3 失败   → 返回 -ENOMEM（不 OOM）
```

`/proc/vmstat` 的 `allocstall_normal`、`allocstall_movable` 等计数，就是进入慢路径的次数。**任何一次 `allocstall` 增长，都对应某些请求在应用线程上下文里同步做了回收/整理的延迟**——这是"内存问题表现为延迟问题"的第一现场。

## 5.2 kswapd：每个 NUMA node 一个的后台回收者

`kswapd`（`mm/vmscan.c` 的 `balance_pgdat`）的规则：

```text
zone free 低于 low  → 唤醒本 node 的 kswapd
kswapd 工作         → 按 priority 调 shrink_node 回收
zone free 回到 high(+余量) 且各 zone 均衡 → kswapd 回睡眠
```

判读口径：

```bash
grep -E 'pgscan_kswapd|pgsteal_kswapd' /proc/vmstat  # 后台扫描/回收量
ps -o pid,pcpu,stat,comm -p <kswapd_pid>             # 是否长期占用 CPU
```

- `pgscan_kswapd` 持续高 + kswapd CPU 高：系统长期在水位线附近"贴地飞行"，回收速度勉强跟上分配速度。
- kswapd 周期性醒来又很快睡去：`watermark_scale_factor` 太小造成"启停振荡"，调大可平滑（第 4 章的权衡）。
- kswapd CPU 高但 `pgsteal/pgscan` 比值低：扫描了大量页却收不走——脏页多（等回写，第 9 章）或页都被 pin 住（第 6/10 章），这是**回收失效**而非回收过载。

## 5.3 direct reclaim：业务线程亲自下场回收

kswapd 追不上（或分配太急）时，分配线程在 `try_to_free_pages` → `do_try_to_free_pages` → `shrink_node` 里同步回收。要点：

1. **代价由谁付**：请求分配的那个业务线程。它的延迟 = 扫描 LRU + 可能的回写等待 + 可能的 TLB shootdown（回收解除映射，第 3 章）。
2. **递归防护**：回收过程中文件系统/块层自己要分配内存时，用 `GFP_NOFS`/`GFP_NOIO` 禁止再次进入对应回收路径，并动用 `PF_MEMALLOC` 预留（第 4 章 `ALLOC_MEMALLOC`）。看到 `__alloc_pages_nodemask` 出现在文件系统栈里且带 memalloc flag，是机制使然，不是异常。
3. **现场证据**：`pgscan_direct`/`pgsteal_direct` 与 `allocstall_*` 同步增长；PSI 的 memory `some` 上升（进程 Stall 在内存上）。direct reclaim 严重时 `perf trace -e 'vmscan:*'` 能看到连续的 `mm_vmscan_direct_reclaim_begin/end` 事件对，**begin/end 间隔就是那一次同步回收的时长**。

> **关键认知**：direct reclaim 不是"内存不够的最后挣扎"，而是**每次低于 min 水位的分配的默认行为**。健康系统的目标是让绝大多数回收发生在 kswapd，direct reclaim 只是零星补丁；`pgscan_direct` 持续增长说明水位与分配速率失配，要按 5.2 的两个方向处理（扩水位或降分配压力）。

## 5.4 compaction：把碎片"搬家"而不是"腾地方"

回收解决"量不够"，compaction 解决"连续不够"。它把分散在多个 pageblock 尾部的可移动页，迁到少数块里，拼出高阶空闲块（`mm/compaction.c`）。三个入口：

```text
被动   direct reclaim 后分配线程顺手 compact
       （order≥2 失败重试时，见 __alloc_pages_direct_compact）
主动   kcompactd 后台整理；比例阈值由
       vm.compaction_proactiveness 控制（约 5.9 引入，默认值与
       语义以本机 mm/compaction.c、Documentation 为准）
手动   echo 1 > /proc/sys/vm/compact_memory （全局 stop-the-world）
       6.x 起有 per-node 接口，路径以本机内核为准
```

观测计数器（`/proc/vmstat`）：

```text
compact_migrate_scanned  搬家侧扫描量
compact_free_scanned     腾位侧扫描量
compact_isolated         实际隔离的页
compact_stall / fail / success
```

`compact_fail` 高的常见原因按嫌疑排序：可移动页不足（大量 pinned/slab 页钉住块）、隔离成功但迁移失败（页忙，`PG_locked`/writeback 中）、目标块被并发分配插队。

## 5.5 碎片的判读与治理

`/proc/extfrag_index` 给出每个 zone 每个 order 的 `unusable_index`（0 到 1）：某阶接近 1，表示虽然空闲页很多，但该阶几乎无可用的连续块。配合第 4 章的 `buddyinfo`：

```text
碎片确诊三联征：
 1. buddyinfo 高阶列（o4 以上）长期为 0
 2. extfrag_index 对应阶 unusable_index 接近 1
 3. compact_fail 增长 或 allocstall 增长但 pgsteal 正常
     （回收没力气了，是"有页不连续"）
```

治理分四层：

```text
临时缓解  低峰手动 compact（注意全局 compact 有毛刺，
          per-node 接口更温和）；重启钉住页的模块/进程
根因修复  减少 pin（mlock/pin_user_pages 滥用）、
          THP defrag 策略降级（第 16 章）、
          长期内核对象与用户可移动页的 zone 分离
架构优化  大页预分配（hugetlbfs 启动期成块，第 16 章）、
          定期滚动重启打断"运行时长尾碎片"
长期治理  监控 buddyinfo 高阶列与 extfrag_index 趋势，
          把碎片作为容量指标管理
```

## 5.6 案例：THP 分配失败引发的延迟台阶

现象：数据库进程周期性出现约百分之几的延迟劣化，无 OOM、`MemFree` 充足。证据链：

```text
thp_fault_alloc 增速放缓 + thp_fault_fallback 增长
 → buddyinfo Node0 Normal o9 列 = 0（4 MiB 以上阶同理）
 → extfrag_index Normal 高阶 unusable ≈ 0.9
 → compact_fail 与故障时刻对齐增长
```

结论：空闲总量不缺，缺的是 **order-9 连续块**；THP 失败回落 4 KiB 后，TLB 命中率下降、缺页次数上升，表现为延迟台阶。修复：降低 `defrag` 激进度的同时从源头治碎片（5.5），并用启动期 hugetlbfs 池替代运行期 THP 申请（第 16 章）。**易错点**：`MemFree` 高不能推翻此结论——碎片诊断从来不看总量。

## 5.7 版本差异提醒

```text
5.10/5.15  回收主循环仍是经典 LRU 优先级模型（第 10 章）
6.1        MGLRU 可选开启，direct reclaim 行为随之变化（第 11 章）
6.x        早期 congestion_wait 一类的固定延时在回收路径被
           陆续移除/重构，等待点更直接落在回写与锁上
           （具体函数演进以本机 mm/vmscan.c 为准，勿背旧图）
```

**本章要点：**

- `allocstall_*` 是慢路入口计数器：每次增长都意味着某个业务线程同步做了回收/整理。
- kswapd 管"量"，compaction 管"连续"；`pgsteal/pgscan` 比值低说明回收失效（脏页/pin），不是过载。
- direct reclaim 的延迟账单由分配者支付；PSI memory 与 vmscan tracepoint 是它的现场证据。
- 碎片确诊看三样：buddyinfo 高阶列、extfrag_index、compact_fail——与 MemFree 无关。
- 治理从手动 compact 到 pin 源削减、hugetlbfs 启动期预分配，按"临时/根因/架构/长期"四层落。

---

# 第 6 章：SLUB - 小对象、slab 膨胀与内核内存账

## 6.1 位置：kmalloc 之下、伙伴之上

内核里大量分配不是整页，而是几十字节的小对象（`task_struct`、inode、dentry、网络 skb 头部……）。SLUB 分配器（`mm/slub.c`）的做法：向伙伴系统按阶批发整页（slab 页），切成同尺寸对象零售。

```c
struct kmem_cache {
    const char *name;         /* dentry、TCP、kmalloc-64 ... */
    unsigned int object_size; /* 对象尺寸 */
    unsigned int objs_per_slab;
    unsigned int oo;          /* order 编码：一个 slab 用几阶页 */
    struct kmem_cache_cpu *cpu_slab;   /* 每 CPU 活跃 slab */
    struct kmem_cache_node *node[];    /* 每 node 的 partial 链 */
};
```

`kmalloc-8/16/32/.../8192` 是一组预建的通用 cache（更大尺寸直接走伙伴/页分配，上限随 `CONFIG` 与版本变化）。一次 `kmalloc(100, GFP_KERNEL)` 实际取自 `kmalloc-128`——**尺寸向上取整到 cache 档位**，这是理解 6.3 浪费的起点。

## 6.2 三层结构：cpu_slab、partial、伙伴

```text
分配  cpu_slab 活跃页的 freelist 取对象（无锁，per-CPU）
补货  活跃页用完 → 从本 node partial 链换一个新 slab
建货  partial 空 → 向伙伴 order-n 取整页，切对象
还货  释放对象 → 挂回 freelist；slab 全空时
        留在 cpu/partial 一定量（min_partial/cpu_partial，
        数值随版本与调优项变化），再空的归还伙伴
回收  shrinker 机制（6.4）在内存紧张时批量归还空/partial slab
```

freelist 不占额外元数据——空闲对象**嵌在对象自己的内存里**（首个字作为 next 指针）。这是"释放后踩到旧数据"类内核 bug 的结构原因，也是 `CONFIG_SLAB_FREELIST_HARDENED`/`RANDOMIZE`（5.x 起）要加固它的原因；安全基线检查时 `slub=hardened` 类 cmdline 即此。

## 6.3 两种浪费：slab 为什么"虚高"

1. **内部浪费**：对象 100 B 存进 `kmalloc-128`，每对象浪费 28 B；加上对齐与 `struct slab` 开销，实际页占用比"对象净需求"高 20-40% 很常见。
2. **外部膨胀**：一个 slab 40 个对象只剩 1 个在用，整页也被扣住不能还给伙伴（partial slab）。对象越"长寿且稀疏"，膨胀率越高。

```text
slab 虚高 ≈ active_objs × (objsize 档位 − 真实需求)
          + partial_slabs × (整页 − 在用对象)
```

诊断只看两个比值：`active_objs / num_objs`（slabinfo 第 2/3 列，低 = 膨胀）、`objsize` 与真实结构体差值（内部浪费）。膨胀率高的 cache，若属 `SReclaimable`，紧张时 shrinker 会自动收（第 10 章）；若是 `SUnreclaim`，就只能靠"少分配"或重启。

## 6.4 SReclaimable 与 SUnreclaim：内核内存的两本账

`/proc/meminfo` 的 `Slab` 拆成两行：

```text
SReclaimable  可回收 slab：dentry、inode、部分 fs 元数据 cache，
              注册了 shrinker，内存紧张时被压回伙伴
SUnreclaim    不可回收 slab：task_struct、内核栈、模块、socket 等
              只要对象还活着，账就一直涨
```

两个典型误判：

- "SUnreclaim 高 = 内存泄漏"：先看 `slabtop` 第一名是谁。`task_struct` 高可能是进程/线程数暴涨（每个线程一份，第 13 章 memcg 也各自记账）；`conntrack` 高是网络跟踪表（nf_conntrack 模块参数才是开关）；只有持续单调增长且对象数对不上业务规模，才支持泄漏结论。
- "SReclaimable 高要立刻处理"：它是**免费的缓存**，回收它等于丢弃加速结构；只要 `memory pressure` 不升高，dentry cache 大通常是"历史访问多"，不是"现在有问题"。

memcg 口径：cgroup v2 的 `memory.stat` 有 `slab`（细分 `slab_reclaimable`/`slab_unreclaimable`，字段以版本为准），**不可回收 slab 也计入组账**——这是容器"RSS 不高却逼近 limit"的第三个嫌疑账本（另两个：页表、内核栈）。

## 6.5 观测入口

```bash
slabtop -o -s c | head -20          # 按缓存大小排序
cat /proc/slabinfo                  # 全量：name active objs objsize ...
grep -E 'Slab|SReclaim|SUnreclaim' /proc/meminfo
ls /sys/kernel/slab/dentry/         # 单 cache 调优项（版本相关）
```

`/proc/slabinfo` 关键列：

```text
name  active_objs  num_objs  objsize  objperslab  pagesperslab
       在用对象      总对象     对象大小  每slab对象数  每slab页数
```

调试内核侧泄漏时（有源码权限、可重启的环境）：`/sys/kernel/slab/<cache>/sanity_checks`、`poison`（5.3 起统一命名，旧版 `red_zone`/`poison` 语义有差异，以本机 `Documentation/ABI/.../sysfs-slab-front-end` 为准），配合 `page_owner`（第 2 章）与 kmem 类 bpftrace/BPF 工具定位分配栈。

## 6.6 案例：40 GB 的 dentry cache 风暴

现象：文件服务器 `SReclaimable` 高达 40 GB，`free` 逼近 min，kswapd 常驻。证据链：

```text
slabtop 第一名 dentry，active_objs 数亿级
 → /proc/sys/fs/dentry-state 与 inode-nr 同量级暴涨
 → 业务是海量小文件 open/stat/close（备份/构建任务）
 → Cached 不高、pgpgin 不高：不是文件内容缓存，是路径缓存
```

要点：dentry 是 `SReclaimable` 不是泄漏；`vfs_cache_pressure`（默认 100）控制 shrinker 对 dentry/inode 的回收倾向，内存压力下调大（如 200-500）可让回收更有效——代价是冷路径重建 lookup 变慢。应急可用 `echo 2 > /proc/sys/vm/drop_caches`（只清 dentry/inode；`=1` 清 page cache，`=3` 全清；**生产慎用，有短暂性能坍塌**），根因在 IO 篇的负 dentry 与 `stat` 风暴治理（跨引用）。

**本章要点：**

- SLUB 是"批发整页、零售对象"：cpu_slab 无锁取、partial 链周转、空 slab 经 shrinker 还伙伴。
- slab 虚高来自档位取整（内部）与 partial 扣页（外部），看 `active/num` 比值定性。
- `SReclaimable` 是免费缓存，`SUnreclaim` 单调涨才像泄漏——先认名字再下结论。
- memcg 里 slab（含不可回收部分）计入组账，是容器"RSS 正常却逼近 limit"的结构性原因之一。
- `slabtop`/`slabinfo` 是日常两板斧；`drop_caches` 与 `vfs_cache_pressure` 是 dentry 风暴的一缓一治。

---

# 第 7 章：缺页的下游 - 一次 fault 如何变成一页物理内存

## 7.1 接缝：从 VMA 走到页分配器

进程侧的缺页处理（VMA 查找、权限判定、`SEGV_MAPERR` 与 `SEGV_ACCERR` 之分）见姊妹篇；本篇从"内核决定提交新页"接手。`handle_mm_fault`（`mm/memory.c`）的分发：

```text
handle_mm_fault
 ├─ do_anonymous_page      匿名写缺页：要一页新物理内存
 ├─ do_set_pte / do_fault  file-backed：page cache 页（第 8 章）
 ├─ do_swap_page           页在 swap：换入（第 12 章）
 └─ wp_page_copy           私有映射写：COW 复制
```

四个分支里前三个都要向第 4/5 章的页分配器要页，第四个还要复制。**缺页风暴 = 分配器流量风暴**，这一句是本接缝的全部要义。

## 7.2 匿名页缺页的成本构成

一次 `mmap(ANONYMOUS)` 区域上的首次写：

```text
分配 order-0 页 + 清零 4 KiB + 建 PTE + 更新 LRU
典型量级（现代 x86 服务器）：亚微秒到几微秒；
页表新建路径（VmPTE 增长，第 3 章）更长
```

两个常被误解的机制：

1. **零页共享**：读缺页（访问未写过的页）可映射全局共享 zero page（`mm/memory.c` 的 `ZERO_PAGE`），省一页物理内存；部分版本对"写入内容恰好为全零"也有复用优化（约 5.7 起，细节以本机 `do_anonymous_page` 为准）。所以"分配了 8 GiB 匿名区、从未写"的 RSS 可以接近 0。
2. **写缺页才真正拿页**：这就是"预触碰（pre-fault）"能消除启动毛刺的原因——把成本从请求路径搬到启动路径（预热见第 16 章与姊妹篇）。

## 7.3 fault_around：只对 file-backed 有效的摊薄

一次文件缺页会顺手把周围区间建好 PTE（`fault_around`，默认窗口 64 KiB，`fault_around_bytes` 可调，可调接口位置随版本，以本机 `mm/memory.c` 与 Documentation 为准）。它的效果边界必须记清：

```text
file-backed 顺序/半随机读：fault 次数下降一个数量级
匿名页 do_anonymous_page：不摊薄——每页仍是独立 fault
⇒ "匿名区 minor fault 很多"是设计如此，不是 bug
```

## 7.4 major fault：换入路径

`do_swap_page` 发现页在 swap（第 12 章）：优先从 swap cache 取（已被异步预读带回），否则发起读。major fault 的延迟 = swap 设备读延迟 + 页表提交，机械盘上可达毫秒级。计数与定位：

```bash
ps -o min_flt,maj_flt -p <pid>     # 首选，避免解析 stat 序号
# 若必须读 /proc/<pid>/stat：minflt 第 10 个、majflt 第 12 个字段；
# comm 可能含空格，解析必须从最后一个 ) 之后数
grep -E 'pgmajfault|pswpin' /proc/vmstat
```

major fault 的调用栈特征是 `swapin_readahead → blk_io_schedule`（或直接 io 等待）——**它同时是一次 IO**，排障时要在 IO 视角（块层队列延迟）里也对账。

## 7.5 THP 缺页与 khugepaged

写缺页落在 THP eligible 的 2 MiB 对齐 VMA 上时，内核尝试直接分配 order-9 复合页（`alloc_thp_vma` 类路径，函数名随版本）。`/sys/kernel/mm/transparent_hugepage/defrag` 决定失败姿态：`always`（同步整理，延迟高）、`defer`/`defer+madvise`（先 4 KiB、khugepaged 后台合并，约 5.9 引入）、`madvise`（仅显式 madvise 区域激进）——取值集合以本机内核为准。

单次 THP 缺页的耗时大头是 **2 MiB 清零**（约 30-150 μs 量级，随内存带宽变化），不是"分配更贵"。khugepaged 事后合并的账：`khugepaged_max_ptes_none`（能替换多少个非空 4K 页）、扫描速率 `khugepaged_scan_sleep_msec` 等，都在 `/sys/kernel/mm/transparent_hugepage/khugepaged/` 下。

## 7.6 锁的演进：从 mmap_sem 到 per-VMA lock

缺页要持什么锁，决定并发 fault 的扩展性：

```text
≤5.7   mmap_sem（读写锁）——多线程并发 fault 读锁可扩展，
       但 VMA 写操作（munmap/mprotect）会造成读者排队
5.8    改名 mmap_lock，语义不变
6.5    per-VMA locks（CONFIG_PER_VMA_LOCK）：缺页只锁单个 VMA，
       真实符号 lock_vma_under_rcu / vma_start_write /
       vma_end_write_all（快路径甚至 RCU 下完成）
```

症状对照：启动期/缺页风暴期大量线程处于 `R` 但 CPU 用不满、perf 里 `rwsem` 等待栈顶是 `do_page_fault`——5.x 上是 mm 锁串行化；6.5+ 开启 per-VMA lock 后此类等待应显著减少（未生效先查 `CONFIG_PER_VMA_LOCK` 与 ftrace 符号）。

## 7.7 观测口径与案例

```bash
grep -E 'pgfault|pgmajfault' /proc/vmstat   # 宿主机全局！容器内同值
cat /sys/fs/cgroup/<ct>/memory.stat | grep -E 'pgfault|pgmajfault'
pidstat -r -p <pid> 1          # minflt/s majflt/s
```

**容器陷阱**：`/proc/vmstat` 未做 namespace 化，容器里读到的是宿主机全局值；容器自己的缺页必须用 cgroup v2 `memory.stat` 的 `pgfault`/`pgmajfault`（v1 无 pgfault 字段，版本口径不同）或 `pidstat`。

案例：Java 容器启动期延迟毛刺。证据链：`pgfault` 以每秒数十万增长、`perf sched` 显示大量唤醒-运行间隔、5.10 内核栈顶 `do_page_fault` 等 `mmap_lock` 读者转换。处理：启动预热触碰堆（把 fault 搬出请求路径）+ `-XX:+AlwaysPreTouch`（JVM 侧细节见 JVM 篇，不重复）+ 升级到带 per-VMA lock 的内核缓解锁竞争。毛刺的**分配器侧成本**（第 4/5 章快慢路径）决定预热速度上限，`watermark_scale_factor` 适当调大可让预触发阶段的同步回收概率下降。

**本章要点：**

- 缺页是分配器、page cache、swap 三条子系统的路由交汇点；`handle_mm_fault` 分发即接缝。
- 读缺页可共享零页，写缺页才真正要页：预触碰把成本从请求路径搬到启动路径。
- fault_around 只摊薄 file-backed 缺页；匿名 minor fault 多不是异常。
- THP 缺页成本大头是 2 MiB 清零；defrag 策略决定"激进同步"还是"先 4K 后合并"。
- 锁演进（mmap_sem→mmap_lock→per-VMA）决定并发缺页扩展性；容器缺页计数看 cgroup，不看 vmstat。

---

# 第 8 章：page cache - address_space、命中、预读与共享

## 8.1 缓存的本质：一页内存的第三重身份

`struct page` 的 `mapping + index` 两个字段（第 2 章）定义了 page cache 的全部身份：**这页属于哪个文件的第几个偏移**。同一文件页被一百个进程 mmap，物理只有一份；smaps 里的 `Shared_Clean/Shared_Dirty` 就是按这个口径统计的。

文件的页挂在 `address_space` 对象上（`include/linux/fs.h`，每个 inode 一个）：

```text
struct address_space
  ├─ i_pages : xarray    （5.x 起取代 radix tree）
  │            偏移 → 页 的稀疏索引
  ├─ 脏页标记、回写控制器 wb（第 9 章）
  └─ a_ops   ：readahead / writepage 等文件系统实现
```

`xarray` 里除了页指针还有**shadow entry（影子条目）**：页被回收后，槽位留下一个标记值，编码"它当初距最近一次使用过了多远"。下次同偏移再缺页，内核用 `refault distance` 判断：刚被赶走的页又回来了——说明工作集大于缓存容量，回收抢来的马上被用掉。这就是 `workingset_refault_*`/`workingset_activate_*` 计数器的来源（命名随版本，5.x 与 6.x 口径差异以本机 `mm/swap.c`、`mm/vmscan.c` 为准）。

## 8.2 读路径与预读窗口

`read()` 命中缓存的路径是 `vfs_read → filemap_read`；未命中才触发缺页/`readpage`。对顺序读，内核维护**非对称预读窗口**（`mm/readahead.c`）：

```text
已读位置
   ↓
[ 窗口尾部 | ← 消费 → | ← 异步预读扩展 → ]
   拖尾收缩，前沿倍增扩张（异步一半、同步一半）
```

参数入口：`/sys/class/bdi/<设备>/read_ahead_kb`（典型默认 128 KiB 量级，随版本与后端变化，以本机为准）、`posix_fadvise(WILLNEED/RANDOM/DONTNEED)`、`FMODE_NOWAIT` 类非阻塞语义。预读的双刃：

- 顺序大文件：窗口快速扩张到上限，磁盘吞吐拉满。
- 小文件/随机读：预读变成**纯浪费的读放大**——`pgpgin` 增长远超应用逻辑读字节数，是这一情况的指纹（8.4）。

## 8.3 Cached 的账目边界

`/proc/meminfo` 的 `Cached` 统计的是可回收的文件页净额，但要记清三处边界：

```text
1. Cached 包含 tmpfs/shmem —— tmpfs 里的文件"是缓存"却不是
   任何磁盘文件的副本，删不掉就降不下；
2. Buffers 另指块设备元数据缓存，与 Cached 分开列；
3. MemAvailable 是 fs/proc/meminfo.c 里的启发式估算
   （free + 可回收 file − 水位保护等），不是硬件事实。
```

"Cached 降不动"的排查次序：`findmnt -t tmpfs` 找常驻大 tmpfs（移走或改介质）→ 检查 mlock/共享内存段 → 检查脏页等回写（第 9 章）→ 检查 workingset 保护（MGLRU 的 `min_ttl_ms`，第 11 章）。

## 8.4 写路径的两种形态（与第 9 章的分工）

`write()` 进 page cache 标记脏页、异步回写（默认路径，第 9 章细讲节流与 `fsync`）；`O_DIRECT` 绕过缓存直接 DMA 到用户缓冲（对齐约束：用户缓冲、文件偏移、长度都要按设备逻辑块对齐，细节见 IO 篇）。`sendfile` 则是"缓存页直接进网络栈"的零拷贝——同一页在 page cache 与 socket 发送队列之间靠引用计数流转。本章的要点只有一条：**绕开 page cache 的负载，本章全部观测口径失效**，要改用 IO 篇的块层口径。

## 8.5 cache 与回收的耦合

干净（clean）文件页是系统里**最便宜的可回收内存**：回收它不需要任何 IO，直接回伙伴（第 10 章会从 LRU 侧重新推演这件事）。脏页则必须先回写变干净才能回收——所以"cache 高 + dirty 高 + 分配紧张"的组合，回收速度被回写带宽钳制（第 9 章的 `balance_dirty_pages` 与 kswapd 的耦合）。这一耦合是内存与 IO 两个子系统最深的一条管道，第 17 章案例会给出量化实例。

## 8.6 观测入口

```bash
grep -E 'pgpgin|pgpgout|workingset|cache' /proc/vmstat
# pgpgin/pgpgout 单位为 KiB，是缓存装载/落盘流量
findmnt -t tmpfs                          # 常驻 tmpfs 清单
perf trace -e 'syscalls:sys_enter_read' -p <pid> --stat  # 读密度
# 命中率需动态探针（bcc cachestat 一类工具统计 filemap 路径命中），
# 无 bcc 时用 pgpgin 增速 ÷ 应用逻辑读字节数估算"无效预读率"
```

## 8.7 案例：大文件随机读把吞吐读没了

现象：分析任务顺序切到随机读后，`iostat` 读带宽暴涨但应用吞吐反降。证据链：

```text
pgpgin 增速 ÷ 应用逻辑读字节 ≈ 20:1（严重读放大）
read_ahead_kb 窗口在随机访问下持续错误扩张
workingset_refault_file 同步增长（换来的页立刻被抢）
```

结论：预读策略与访问模式错配，page cache 在"搬运没人要的页"。修复：应用侧 `posix_fadvise(POSIX_FADV_RANDOM)` 关预读，或降低 bdi `read_ahead_kb`；配合第 10 章把该负载的文件页隔离进独立 cgroup（`memory.high` 限其 cache 账）。**易错点**：不要调 `page-cluster`——那是 swap 预读参数（第 12 章），与文件预读无关。

**本章要点：**

- page cache 的身份是 `mapping+index`：文件页全局唯一、跨进程共享，smaps 的 Shared 口径由此而来。
- xarray 的 shadow entry 让"回收后又被要回"可量化——`workingset_refault` 是缓存容量不足最硬的证据。
- 预读是非对称窗口：顺序读的加速器、随机读的读放大器；`pgpgin` 对账是诊断指纹。
- `Cached` 含 tmpfs、`Buffers` 是元数据、`MemAvailable` 是启发式——三个词不是一个意思。
- 干净文件页是最便宜的回收来源；脏页回收被回写带宽钳制，这是内存-IO 耦合的主管道。

---

# 第 9 章：dirty 与回写 - bdi、节流与 fsync 的代价

应用 `write()` 落进 page cache 就返回，磁盘永远慢半拍。回写子系统的职责不是"尽快落盘"，而是**在写入者速率、磁盘带宽与回收空间之间做三方仲裁**。大量"磁盘明明不忙、写入却卡住"与"周期性 P99 毛刺"的根因都在这一章。

## 9.1 脏页的账本：谁在记，谁来清

一个 folio 被写脏时走 `folio_mark_dirty`，同时它的 inode 被挂进对应 **bdi（backing dev info）的 writeback 链表**——回写的工作单元是 `wb_writeback_work`，执行者是 per-wb 的内核线程（`writeback` kworker）：

```text
write() -> 拷入 page cache -> 标脏，folio 入 wb 脏链表
后台刷：wb_writeback 线程
  -> 按"脏龄过期"或"总量越线"挑选 folio
  -> ->writepages 提交 bio -> 设备
写者侧：balance_dirty_pages() 周期性检查总账
```

> **关键认知**：账本有两套粒度。全局账（`nr_dirty`、`nr_writeback`）决定写者是否被节流；per-wb 账决定谁去刷。4.x 起 wb 按 memcg×bdi 分片（cgroup writeback），**脏页记账能分到家，但节流墙至今仍是全局的**——这是第 13 章 memcg 与 IO 耦合的伏笔。

## 9.2 四条阈值线：默认值只是起点

`/proc/sys/vm/` 下四个参数构成回写的"红绿灯"：

| 参数 | 上游默认 | 语义 |
|---|---|---|
| dirty_background_ratio | 10 | 超过后唤醒后台刷盘，写者不受限 |
| dirty_ratio | 20 | 节流墙，写者在此被按比例减速 |
| dirty_expire_centisecs | 3000 | 脏龄超 30 秒的页在下轮刷新时强制落盘 |
| dirtytime_interval | 500 | 6.x 引入的脏龄轮询间隔，有无以本机为准 |

两个容易踩的口径问题：

1. **ratio 的分母不是总内存**。全局阈值换算时用的是"free + 可回收内存"量级，具体见 `mm/backing-dev.c` 的 `global_dirty_limits`；同一台机器不同负载下，触发线会漂移。
2. **bytes 版优先于 ratio 版**。`dirty_bytes`/`dirty_background_bytes` 一旦设为非零直接覆盖对应 ratio——大内存机器上 ratio 会让"墙"高到磁盘永远追不上，数据库类负载常用 bytes 封顶。

## 9.3 balance_dirty_pages：不是撞墙，是被限速

写者每写一批页调用一次 `balance_dirty_pages_ratelimited`。真正节流时并非睡到脏量降下来，而是计算一个位置比例：

```text
R  = 当前脏量
Bg = 后台启动线
B  = 节流墙
pos = (R - Bg) / (B - Bg)  截断到 0..1
写者允许速率 = f(pos)：pos 越大允许越慢，趋向硬墙时趋向阻塞
```

这是反馈控制：脏量越线初期只是"减速带"，之后越来越重。所以**"写者 D/S、磁盘 %util 不满、吞吐却上不去"三者可以同时为真**——瓶颈在节流算法而非设备。判断方法：

- `/proc/pressure/io`：some avg 是否在写者被卡的时间窗内抬升。
- `/proc/vmstat`：`nr_dirty` 是否贴着 background 与墙之间锯齿；`writeback:writeback_queue`、`writeback_single_inode` tracepoint 可直接看谁在排队（本机 `ls /sys/kernel/debug/tracing/events/writeback/` 为准）。
- `/sys/class/bdi/<dev>/`：`max_ratio`、`strict_limit` 可做 per-bdi 配额（如给慢设备限死占比，防止一个坏盘拖垮全局脏账）。

> **关键认知**：`dirty_ratio` 引发的节流是**全局连坐**——一个进程制造脏页，所有写者按同一把限速器减速。容器场景这是跨租户干扰的经典通道（第 13 章）。

## 9.4 fsync 的语义与它真正贵的地方

`fsync(fd)` 要做三件事：把该文件脏页写回（`filemap_write_and_wait`）、把支撑数据的**元数据**落盘（ext4 有序模式下即把事务提前 commit，`jbd2`）、最后**flush 设备易失缓存**（barrier/FUA）。常见误区：

1. **新建/改名文件必须 fsync 父目录**。dentry 属于目录 inode 的数据；只 fsync 文件本身，掉电后内容在、文件名可能不在。
2. `fdatasync` 只等数据与"读回该文件必需的元数据"，跳过 mtime 等，对高频提交更省。
3. `sync()` 是全局大棒：所有 bdi 一起刷，监控里偶发的整机 IO 洪峰先查有没有脚本在调 sync。
4. fsync 的耗时下限是"一轮设备往返 + 事务提交"，与脏页多少不成正比——高频小 fsync 比低频大 fsync 贵得多。

观测 ext4 侧的直接证据是 `jbd2/<dev>-8` 线程的 run time 与 `transaction_id` 推进速率；journal commit 慢时，fsync 排队会先于设备成为瓶颈。

## 9.5 与回收的耦合：脏页是回收路上的减速带

第 8/10 章说过：回收器遇到脏页不能直接释放，只能 `pageout` 交回写、等完成后再回收。于是形成一条因果链：

```text
内存压力 -> kswapd 优先回收 file LRU
        -> 脏的 file 页需要先回写才能释放
        -> 回写带宽被抢占 / 设备变慢
        -> shrink_page_list 里 folio 被 keep（writeback 未完成）
        -> allocstall 升高，PSI memory 与 PSI io 同时抬
```

**iowait 高不等于磁盘慢**：这条链里磁盘可能只是"忙"，真正的问题是回收在等回写。区分手段：`iostat -x` 看 `%util`/`await` 是否先到瓶颈，再对照 `/proc/vmstat` 的 `nr_writeback` 与 `allocstall_*` 的时间相关性。

## 9.6 实验与案例：checkpoint 风暴

设计实验（观察节流墙效应）：

```text
终端A：fio 顺序写 4GiB/s 级压力，不开 fsync
终端B：watch -n1 读 /proc/vmstat 的 nr_dirty 与
       /proc/pressure/io
把 dirty_ratio 从默认降到 5，重跑：
预期 A 的写速率被压低、B 的脏锯齿峰值变小、毛刺频率变高
```

**案例：某 OLAP 引擎周期性 P99 写延迟尖刺（每 5 分钟一次）**。证据链：尖刺时刻 `nr_dirty` 恰从 `dirty_background_ratio` 线冲向 `dirty_ratio`；`writeback_single_inode` tracepoint 显示单 inode 一次提交数万页；设备侧 `iostat` 的 `w_await` 同步上跳——是**后台大批量刷 + 前台撞墙节流**的叠加。修复不是调大墙，而是反向：降低 `dirty_background_ratio` 让刷盘"早启动、小批量"摊平曲线；checkpoint 改为分片 fsync；慢盘设 `bdi max_ratio` 隔离。教训：**回写参数调优的目标是削平锯齿，不是抬高天花板**。

## 9.7 版本差异

- 5.10：wb 分片（cgroup writeback）早已成熟；无 `dirtytime_interval`。
- 6.6：脏龄轮询参数进入主线；balance 相关调试计数器持续增加，`/proc/vmstat` 字段以本机为准。
- cgroup 级脏页节流：截至 6.6 主线节流墙仍为全局；是否已有 per-cgroup 开关，查本机 `Documentation/admin-guide/cgroup-v2.rst` 的 io 章节，不要照搬博客。

**本章要点：**

- 回写是三方仲裁：写者速率、磁盘带宽、回收空间；节流墙是全局连坐的反馈限速，不是撞墙才停。
- ratio 的分母不是总内存；bytes 版覆盖 ratio 版；大内存机器慎用默认 ratio。
- fsync 三件事：数据、元数据、设备缓存；新建文件要 fsync 父目录；高频小 fsync 最贵。
- 回收遇脏页必须先回写：allocstall 与 nr_writeback 同时抬升，说明是"回收等回写"而非磁盘慢。
- 调优方向是"早启动小批量"摊平锯齿，而不是抬高 dirty_ratio 天花板。

---

# 第 10 章：回收主循环 - LRU、shrink_node、priority 与 refault

第 9 章讲了脏页怎么还债，本章讲回收器怎么挑人。这是整个 mm 子系统里代码量最大、现场问题最密集的一条主线（`mm/vmscan.c`）。

## 10.1 LRU 矩阵：两维四列加一个豁免区

页按"来源×冷热"挂进多条链表，组织单位是 `struct lruvec`（per-memcg per-node）：

```text
            inactive      active
file        候选回收区     被引用过的文件页
anon        候选回收区     被引用过的匿名页
unevictable 豁免区（mlock 等，不参与回收）
```

> **关键认知**：active/inactive 不是严格 LRU，而是**过页表采样的近似**。`mark_page_accessed` 把 inactive 命中页提升到 active 的"提升"路径是廉价的；反过来把 active 降回 inactive 需要老化扫描（遍历页表读 accessed bit）——贵的那一步恰恰是获取"冷热"真值的代价。冷热识别的一切失真都来自这里（第 11 章的动因）。

lru 链表本身不需要额外分配：`struct page` 的 `_last_pgmap_unused`/lru 字段直接串链——影子成本第 2 章已算过。

## 10.2 get_scan_count：swappiness 是一次加权，不是开关

回收器先决定本轮从 anon LRU 和 file LRU 各扫多少。`get_scan_count` 的输入包括：两类 LRU 的大小、refault 历史、是否需要 swap、以及 `vm.swappiness`（默认 60，文档口径允许 0-200，大于 100 表示更偏 anon）。两个必须纠正的口径：

- **swappiness=0 不是"绝不换出"**：主线语义是"只要还有可回收的 file 页就优先 file"，极限压力下 anon 仍可能被动；真要禁止，用 cgroup v2 的 `memory.swap.max=0`（第 13 章）或干脆不给节点配 swap（第 12 章）。
- **swappiness=200 也不是激进**：它只是在计算扫描比例时给 anon 侧更高权重，最终仍受两类 LRU 尺寸与回收目标约束。

无 swap 设备时，anon 侧直接不扫，file 吃满——这是"关 swap 的机器回收全打在 page cache 上、IO 抖动反而更大"的机制来源。

## 10.3 shrink_node：从唤醒到逐页判决

```text
kswapd / direct reclaim
  try_to_free_pages -> do_try_to_free_pages -> shrink_zones
    -> shrink_node                     每 node 一次
       -> shrink_node_memcgs           5.9 起按 memcg 迭代
          -> shrink_lruvec
             -> 老化（遍历页表清/读 accessed）
             -> shrink_list -> shrink_inactive_list
                -> isolate_lru_pages   从 inactive 尾部摘一批
                   -> shrink_page_list 逐页判决
```

外层有一个 priority 循环：起始 `DEF_PRIORITY`（主线长期为 12），本轮隔离量不足以完成目标则 priority 减一，**扫描距离（scan_balance 的窗口）指数放大**。设计意图是"温和多轮"优先，priority 掉到个位数说明温和手段已经失效：`/proc/vmstat` 里对应的高轮次 `pgscan`/`compact_fail` 会成对飙升。

`shrink_page_list` 的逐页判决顺序（简化）：

```text
被 mmap 且 mapcount 大于 1？ -> 先试 try_to_unmap 共享映射
folio 正被 writeback？       -> keep，等下一轮（第 9 章的减速带）
脏？                         -> pageout 提交回写，不等待
anon 且可 swap？             -> 分配 slot，try_to_unmap，入 swap cache
mapped 且首次遇到？          -> deactivate 回 inactive 给一次机会
干净可回收？                 -> 释放回 buddy
```

**mapped 页的两步驱逐**值得单独强调：正在被进程映射的页，第一轮只被摘出链表放回 inactive（deactivate），第二轮再被隔离时才真正 unmap——这解释了"回收风暴时 inactive anon 先涨后跌"的中间形态。

## 10.4 refault distance：回收器不知道"错了"，但影子知道

页被回收时，内核在 page cache 的 xarray 里留一个 **shadow entry**（第 8 章）记录"你在哪个位置被逐出"。下次同页再 fault：

```text
refault_distance = 当前回收位置 - 逐出时记录的位置
distance 大于逐出时该 LRU 链表长度？
  -> 说明它"转完一圈"就回来了：其实并不冷
  -> 直接放回 active（workingset_activate_*），否则回 inactive
```

由此得到全篇最硬的一个故障指标：

```text
workingset_refault_file / _anon  被错误逐出后又回来的次数
workingset_activate_*            其中被判为"不该冷"而提升的
workingset_nodereclaim           因 refault 而放弃本轮回收强度
```

> **关键认知**：`pgsteal` 高不等于回收有效。**回收质量看 refault，回收强度看 pgscan，两者比值与 PSI 合起来才是"抖动"的完整证据**。thrashing 的定义：pgscan/pgsteal 持续高企、`workingset_refault_*` 增速不减、吞吐随之下掉——系统在"搬运自己"。

## 10.5 观测面板：三屏看完一条因果链

```text
屏1 强度： /proc/vmstat
   pgscan_kswapd / pgscan_direct     后台 vs 前台扫描
   pgsteal_kswapd / pgsteal_direct   实际摘除量
   allocstall_*                       分配即回收的次数
屏2 质量： 同文件
   workingset_refault_* / _node
   或直接看 /proc/pressure/memory 的 some avg
屏3 代价： iostat + /proc/vmstat
   nr_writeback / nr_dirty（回写拖累）
   pswpout / pswpin（swap 拖累）
```

`pgscan_direct` 与 `pgscan_kswapd` 的比例是最常用的分诊刀：几乎全是 kswapd，说明水位机制在正常工作，只是内存确实紧张；direct 占比高，说明分配跑赢了回收，第 5 章的水位/碎片治理要回头看。MGLRU 开启后这些计数器仍存在但语义并入代际扫描（第 11 章），对照时注意。

## 10.6 案例：被当成"内存泄漏"的回收失效

某缓存服务 RSS 稳定但吞吐周期腰斩。初诊"该重启了"——证据不允许：

- `pgscan_direct` 与 `workingset_refault_file` 同窗飙升：回收在疯狂扫 file LRU 且逐错；
- `mlock` 检查：业务把热点数据 mmap + mlock，unevictable 吃掉大半内存，可回收池被压缩；
- `swappiness` 保持默认 60，但节点无 swap，anon 不参与、file 被反复错杀。

根因：**可回收面积被 mlock 挤占 + 无 swap 使 anon/file 天平单边倒**，不是泄漏（RSS 稳定即证据）。修复：缩小 mlock 范围、给节点配 zram（第 12 章）恢复 anon 侧的回收纵深。教训：`MemAvailable` 低只是症状，第 8 章说过它是启发式；判断"还能不能回收"要看 LRU 分布（`/proc/zoneinfo` 的 anon/file 计数）与 refault。

**本章要点：**

- LRU 是按"来源×冷热"的采样近似；老化扫描贵，冷热失真由此而来。
- swappiness 是权重不是开关；真禁止 swap 用 `memory.swap.max=0`；无 swap 节点回收全打在 file 上。
- shrink_node：priority 从 12 起步，失败降档指数放大扫描；mapped 页两步驱逐。
- 回收强度看 pgscan/pgsteal，回收质量看 workingset_refault，两者背离即 thrashing。
- pgscan_direct 占比是"水位失守"的分诊刀；MGLRU 下计数器语义要重新对照。

---

# 第 11 章：MGLRU 与 DAMON - 新一代冷热识别

第 10 章的冷热失真不是调参能修的——它是 active/inactive 两档结构 + 昂贵页表老化的固有代价。6.1 合入的 MGLRU 和 5.15 合入的 DAMON 是两条不同的解法。

## 11.1 老 LRU 的三个结构性问题

1. **两档太粗**：热/温/冷只有"active 或 inactive"两种表达，回收决策缺少梯度。
2. **老化太贵**：清 accessed bit 要遍历 rmap 下所有 PTE，大内存机器一轮老化分钟级，冷热信息在老化周期内严重过期。
3. **采样噪声**：`mark_page_accessed` 的一次命中就能提升，流式读的大页把 active 灌满，真正的热点被稀释。

## 11.2 MGLRU：代际 + 并行老化

MGLRU（`mm/lru_gen.c`，老化逻辑在 `mm/vmscan.c` 的 lru_gen 分支）把每类 LRU 扩展为**多个代（generation）**，新访问进新代，回收从最老代成批摘除——近似 clock 算法的精细版。关键设计：

- **老化与回收解耦**：老化的本质是"页表扫描 + accessed bit 收割"，MGLRU 把它组织成可**并行分片**的 walk，多个回收线程各扫一段地址空间，把分钟级压到秒级。
- **扫描距离直接表达为代**：priority 循环仍在，但"扫多少"由代际容量自适应，减少"指数放大扫描"的粗暴档位切换。
- **workingset 检测保留**：shadow entry 与 refault distance 的机制不变，第 10 章的诊断口径在 MGLRU 下仍然成立。

开关与观测（主线口径，发行版可能预开）：

```text
/sys/kernel/mm/lru_gen/enabled        bitmask；文件不存在=未编译
  0x0007 = 主开关+aging+eviction 全开
/sys/kernel/mm/lru_gen/min_ttl_ms     页的最小年龄保护
/sys/kernel/debug/lru_gen             手动 list/age/evict 调试
/proc/swaps 之外：/proc/vmstat 中 lru_gen 相关计数（以本机为准）
```

`min_ttl_ms` 是为 Android 这类"低内存但忌抖动"场景设计的：保证任何页至少活过 TTL，回收只碰真老的页——它把第 10 章"错杀"的代价从统计信号变成硬约束。

> **关键认知**：MGLRU 是**原地替换 LRU 引擎**，上层（reclaim 主循环、memcg、swap 路径）接口不变；评估它好坏的方法就是第 10 章那套：开关前后比 `workingset_refault`/`pgscan`/PSI，而不是看 MemAvailable。

## 11.3 DAMON：不在 LRU 里的旁路侦察兵

DAMON（`mm/damon/`，5.15 合入）换了一个问题："不做回收时，系统能不能随时知道哪些内存是冷的？"它把物理地址空间切成 region，**按 access rate 直方图持续采样**（定期清 accessed bit 统计命中次数），完全独立于 LRU 与页表老化节奏。

合入的两个消费者（scheme）：

- `DAMON_RECLAIM`：按采样直接远程回收长期冷的 region（可走 `madvise_cold` 类语义），给 kswapd 减负。
- `DAMON_LRU_SORT`：把采样结果反向喂给 LRU——冷的降档、热的保档，修正第 10 章的近似误差。

管理入口在 sysfs（`/sys/kernel/mm/damon/admin/kdamonds/...`，层级 `cat` 可见；5.15 早期另有 `damon_reclaim` 模块参数形态，6.x 统一走 sysfs，接口以本机为准）。

**THP 注意**：DAMON 的访问检测以 4K 粒度读页表 accessed bit，region 覆盖 huge page 时冷热只能按整块表达（社区长期有 hugepage 粒度限制的报告）——大页负载上它的精度收益会打折，实验前先看 `nr_accesses` 分布。

## 11.4 怎么选型：两条路线的边界

```text
问题             MGLRU                DAMON
定位             替换 LRU 引擎        旁路冷热侦察 + 动作
侵入性           低（接口不变）        低（不碰回收主路径）
收益场景         大内存/高 churn/      冷数据占比高、想主动
                 Android 抖动治理      腾内存或修 LRU 排序
成本             内核升级              采样 CPU 税（可调）
风险             行为变化需回归        THP 下精度下降
```

判据仍是第 10 章的面板：如果 `pgscan_direct` 高 + refault 高（老化过期导致的错杀），MGLRU 对症；如果 RSS 巨量但长期冷的比例高且不想动回收器，DAMON_RECLAIM 对症。两者不互斥。

## 11.5 实验设计：一次合格的 A/B

1. 用固定回放负载（同一数据集顺序重放），记录 30 分钟基线：`pgscan_*`、`workingset_refault_*`、PSI memory some avg、业务 P99。
2. 只切一个变量：`echo 0x0007 > /sys/kernel/mm/lru_gen/enabled`（或反关）。
3. 同负载再跑 30 分钟，**对比 refault 斜率而不是内存曲线**——冷热识别改进的直接指纹是"同样回收量下逐错更少"。
4. 对照组警惕：同期别动 swappiness 与 min_ttl_ms，否则归因失效。

**本章要点：**

- 老 LRU 的病根是两档太粗 + 页表老化太贵，冷热信息在大内存机器上系统性过期。
- MGLRU 用代际 + 并行页表扫描原地替换 LRU 引擎，`min_ttl_ms` 把防错杀变成硬约束。
- DAMON 是独立采样的旁路侦察兵：DAMON_RECLAIM 腾冷内存，DAMON_LRU_SORT 修正排序。
- 评估口径不变：比 refault 斜率与 pgscan/pgsteal 比，不是比 MemAvailable。
- THP 负载上 DAMON 精度受粒度限制，上线前先验证 access rate 分布。

---

# 第 12 章：swap、zswap 与 zram - 被压制的第二层

file 页还不起账可以丢弃（文件还在磁盘上），anon 页没有后备存储——它的全部出路只有两条：**swap，或者被 OOM 杀掉**。本章讲第一条，第 14 章讲第二条。

## 12.1 anon 页的账本：swap slot 从哪来

回收器决定驱逐一个 anon 页时（第 10 章判决链），先在一个 swap device 上分配 slot（`mm/swapfile.c`），页脱离所有映射进 swap cache，回写线程把 slot 数据写入设备；再次 fault 时从 swap cache 或设备读回、释放 slot。

两个容易被误用的参数：

- **`vm.page_cluster`（默认 3）**：换入时的预读粒度，按 2 的幂取 8 个 slot——第 8 章案例警告过，它管 swap 不管文件预读。顺序换出时 cluster 有效，随机换入时它是纯放大。
- **swap priority（0-32767）**：多设备时的分配顺序，高优先用满才降级；把 zram 设高优先、磁盘 swap 设低优先，是典型的"分层 swap"玩法。

> **关键认知**：swap 不是"内存不够才用的功能"，而是**回收器给 anon 侧准备的唯一泄压阀**。彻底关 swap 的机器，anon 压力无处分摊，回收全打在 file LRU 上（第 10 章），OOM 阈值也被迫收紧——"生产一律关 swap"是一条需要场景限定的经验而非定律。

## 12.2 zswap：写盘之前的压缩缓存

zswap（`mm/zswap.c`）挂在 swap writeout 路径前面：换出的页先压缩进内存池（zsmalloc 分配器），池命中就不碰设备；换入时池里有就原地解压。

```text
anon 驱逐 -> [zswap 压缩入池] --池满/拒绝--> [swap 设备落盘]
换入 fault -> [池命中: 解压返回] 或 [设备: 读回(再压缩入池)]
```

关键行为与参数：

- `max_pool_percent`（默认 20）：池上限按**总内存百分比**计；池满时按 LRU 把最老的压缩页写回真实 swap（zswap writeback）——所以 zswap 生效的前提是**真有 swap 设备**，它只是缓存层。
- `accept_threshold_percent`：压缩比太差（近不可压页）直接放弃入池，省下解压也解不动的 CPU。
- 后端存储 6.0 起从 rbtree 换为 xarray（为 per-cgroup zswap 铺路）；老内核上大批量同地址换出时 rbtree 的扩展性问题是已知瓶颈。
- 观测：`/sys/module/zswap/parameters` 看配置；debugfs `zswap/` 下 `pool_total_size`、`stored_objects`、`written_back_object`、`reject_*`（文件名以本机为准）；`/proc/vmstat` 的 `zswpin/zswpout`。

## 12.3 zram：设备本身就是一个压缩块

zram（`drivers/block/zram/`）是一个用 zsmalloc 存压缩页的**块设备**，常直接格式化为 swap：不需要真实磁盘，换出=压缩留在内存，换入=解压。`/sys/block/zram0/` 下 `disksize`（逻辑上限，可设成数倍物理内存而只按实占计费）、`mm_stat`（`orig_data` 与 `comp_data` 之比就是实时压缩率）、`max_comp_streams`。算法上 lz4 系低延迟、zstd 系高压缩比，是通用的取舍口径（具体支持列表看 `compaction_algorithm`）。

zram vs zswap 的定位区分：

```text
zswap  = swap 设备前面的内存缓存层（设备必须存在）
zram   = 本身就是设备（没有真实磁盘的第二层）
组合   = zram 高优先 + 磁盘 swap 低优先：先压缩、再落盘
```

代价两面：压缩解压吃 CPU；zram 的"第二层"仍占内存——`disksize` 超卖不等于容量超卖，池满即回收失败（`mm_stat` 的 `fail_count`）。

## 12.4 观测：三组数字定一条因果链

```text
vmstat 1 的 si/so，/proc/vmstat pswpin/pswpout  —— 换页速率
/proc/PID/smaps 的 Swap: 与 memcg memory.swap.current —— 谁在盘上
/proc/pressure/memory + iostat 的 swap 设备 await  —— 换入的延迟代价
```

判读模板：`so` 持续为正且 `allocstall_direct` 同窗——回收在用 swap 泄压（可接受）；`si`（换入）突刺伴随业务 P99 尖刺——工作集真实超过内存，swap 只是在把 OOM 换成慢（不可长期接受）；两者都不高但 `pgscan_direct` 高——问题在 file LRU 或碎片，回到第 5/10 章。

## 12.5 案例：一台"不能加内存也不能关 swap"的容器宿主

某宿主机 Java 侧频繁 Full GC 且伴随节点级延迟尖刺。证据链：`so` 持续高（堆被换出）→ 堆内对象访问触发 `si` 尖刺 → GC 扫描全堆把"换出成本"一次性放大成秒级停顿 → GC 期间内存不降反触发 OOM 风险。**先加 swap 只缓解死亡，不缓解停顿**。修复三步：zram 高优先 + lz4 压低换入延迟；JVM 侧 `Xmx` 对齐容器 limit 并开启透明大页前先做第 16 章的评估；cgroup `memory.swap.max` 给每个容器封顶，杜绝单容器把全节点换穿。教训：**swap 的引入要同时回答"换入延迟能否承受"，只回答"OOM 能否避免"是不够的**。

**本章要点：**

- anon 页只有 swap 与 OOM 两条出路；page_cluster 管 swap 预读，与文件预读无关。
- zswap 是 swap 设备前的压缩缓存，池满写回设备；accept_threshold 挡不可压页；6.0 起 xarray 后端。
- zram 本身就是设备：disksize 可超卖、按实占计费，fail_count 与 mm_stat 是账本。
- so 持续是泄压，si 尖刺是工作集真实超限；关 swap 前先想清楚 anon 的账谁来付。
- 引入 swap 的决策要同时评估换入延迟路径（GC/扫描类负载最容易被 si 放大）。

---

# 第 13 章：memcg - 控制组的账本与 memory.high

容器时代的"内存"是两个词：物理内存，和**账本内存**。memcg（cgroup v2 的 memory 控制器，`mm/memcontrol.c`）给前者记账、给后者执法。90% 的容器内存告警，读对了账本就能一次定位。

## 13.1 什么记在容器的账上

`memory.current` 不是"进程 RSS 之和"，它包含：

```text
anon        堆/栈/匿名映射
file        该容器 fault 进来的 page cache（谁读进账算谁的）
slab        可回收与不可回收都记账
pagetable   页表本身（大 RSS 进程的隐性大头）
kernel_stack 等内核分配（v2 口径，项目以 memory.stat 为准）
swap        单列在 memory.swap.current，不混进 current
```

> **关键认知**：一个只"读文件"的容器可以 RSS 很小而 `memory.current` 很大（file 记账）；一个"没分配内存"的容器可以为页表买单（第 7 章：页表也是内存）。`memory.stat` 的 `anon/file/kernel_slab_reclaimable/kernel_slab_unreclaimable` 分组就是查账入口。

配套文件一页速览：

| 文件 | 语义 |
|---|---|
| memory.min / low | 硬保护 / 软保护（回收尽量绕开） |
| memory.high | 软上限：超了不报错，边冲账边回收 |
| memory.max | 硬上限：超了先回收，回收不动就 OOM |
| memory.swap.max | swap 账本上限，0 即禁 swap |
| memory.stat | 分组账本 + refault/fault 计数 |
| memory.events | low/high/max/oom/oom_kill 的累计次数 |
| memory.pressure | 该组的 PSI memory |

## 13.2 memory.max：回收的前台化

冲到 `max` 不会立刻失败——分配线程被拉去做**本 memcg 范围的回收**（复用第 10 章 shrink 逻辑，作用域是这棵子树的 lruvec），回收把用量压回 max 以下才继续。只有"回收不出空间"才升级 OOM（第 14 章，constraint 为 memcg）。所以"容器贴着 limit 跑"的常态表现是：**分配延迟上升 + `memory.events` 的 max 计数缓涨，而不是报错**。

## 13.3 memory.high：最容易被误用的"温柔上限"

`high` 与 `max` 的本质区别：high 永不触发 OOM，代价改成**在分配路径上做同步回收并主动节流**。这带来两个反直觉现象：

1. **业务 P99 抖、CPU 高，但内存"没满"**—— throttling 回收吃的是分配线程的时间片；查 `memory.events` 的 high 增长与 `memory.pressure`，别看节点水位。
2. **设得越低越慢，不是越省**：high 低于真实工作集时，回收永远追不上，节流越来越狠，等效于给进程"减速带拉到最高"。

## 13.4 memory.min / low：保护是稀缺资源

min 要求回收尽量绕开该组（生存级压力除外——OOM 前一刻保护让位于"总得有人死"）；low 是软版。两个陷阱：

- **保护总量超过物理内存**：回收器"无账可查"，全局 direct reclaim 反而变本加厉——给每组都设了 low 等于谁都没设。
- **层次继承**：保护在树上逐级聚合，父组的 low 会罩住子树，排错时要从 root 往下读每一层的账。

## 13.5 working set：K8s 那个公式为什么长这样

`container_memory_working_set_bytes = memory.current - inactive_file`（cgroup v2）。减 inactive_file 的理由：文件页冷尾巴是**随时可丢弃的借住者**，不代表业务的真实占用。但这公式有两个边界：

1. `active_file` 没减——热文件缓存仍算工作集，对重度用 page cache 的负载（数据库、缓存代理）会**高估**真实不可丢内存。
2. tmpfs/shmem 是 anon 侧记账（第 8 章），减不掉也丢不掉——"用 /dev/shm 撑大工作集"是 K8s 驱逐误报的经典来源。

驱逐、VPA、limit 规划都基于这个数，读懂它的两条边界才不会把"公式"当"事实"。

## 13.6 跨组耦合的两条暗管道

- **脏页全局墙**（第 9 章）：某容器制造海量脏页撞上 `dirty_ratio`，被节流的是**所有容器的写者**——账本分到家，墙还是全局的。
- **page cache 的"先读先得"**：文件页记在首次 fault 它的容器账上；镜像层被多个容器重复读不重复计费（同页同账），但**谁先来谁背锅**，新扩容容器可能继承"前人留下的脏账"。

## 13.7 案例：CPU 高、内存没满、P99 每十分钟一抖

某服务 sidecar 采集器导致主容器周期性变慢。证据链：`memory.events` 的 high 每十分钟跳增一次，与抖动同窗；`memory.current` 稳贴在 high 附近；抖动时刻主容器 `memory.pressure` 的 some avg 抬升、节点内存充裕。**根因：limit 迁移时把 memory.high 设成了历史用量均值**，采集器批量读文件把 current 推过 high，同步回收全落在业务分配线程上。修复：high 上调到工作集 + 冷文件余量，采集器限读速。**教训：high 不是"提前预警线"，是"开始收税线"——它必须高于正常波动带。**

**本章要点：**

- memory.current 记 anon+file+slab+pagetable 等全部账，swap 单列；RSS 小不等于账小。
- max 是"回收失败才 OOM"的硬上限；high 是永不 OOM 但用同步回收收税的软上限。
- min/low 是稀缺资源：保护总量超物理内存等于没设；层次聚合要从 root 往下读。
- working set = current − inactive_file，高估热文件缓存、低估不得 shmem——公式不是事实。
- 脏页墙与 file 记账是跨容器干扰的两条暗管道。

---

# 第 14 章：OOM - 选择、oom_reaper 与容器 OOM

OOM 不是"内存没了的报错"，而是**内核在"继续慢"与"死一个"之间做的强制平仓**。读不懂平仓规则，就会把"为什么杀它"归结为玄学。

## 14.1 谁有资格触发 OOM

三个门槛，少一个都不杀：

1. **回收失败**：direct reclaim 做尽（priority 降到底、compaction 试过）仍拿不到页。
2. **order 门槛**：只有 order ≤ `PAGE_ALLOC_COSTLY_ORDER`（主线长期为 3，即 32KiB 以下）的分配失败才走 OOM；**高阶分配失败只返回 -ENOMEM，绝不杀人**——这解释了"内存明明耗尽，申请大块的驱动只是报错"（第 5 章）。
3. **作用域内有可杀对象**：全局、cpuset、还是某个 memcg——`constraint` 类型（NONE/MEMCG/CPUSET/MEMORY_POLICY）写进日志，决定后文怎么读。

## 14.2 oom_badness：选靶子的算术

内核给每个有 mm 的任务打分，简化模型：

```text
badness ≈ （该任务 RSS + swap 占用 + 少量内核账）
          ÷ 可回收总量的视角
oom_score_adj：-1000..1000 人工倾斜
  -1000 = 完全豁免；正值提高被杀概率
```

`/proc/PID/oom_score` 与 `/proc/PID/oom_badness` 可以**事前查分**——OOM 之后争论"为什么是它"是考古，事前读这两个文件是体检。注意三点：

- 打分看的是**占用**，不是罪过：缓存型进程（大 RSS）天然分高，数据库 page cache 大即是"原罪"。
- kernel thread 不参选；共享同一 mm 的线程组作为一个整体计。
- adj 只是倾斜，不是免死（除 -1000）：K8s 给组件设负 adj 降低被杀顺序，不改变"该节点真没内存"的事实。

## 14.3 杀掉与 reap：SIGKILL 之后内存并没有还回来

选中 victim 后 SIGKILL，但内存释放要等它**退出**——如果它卡在 D 状态（IO 等待、被人持锁），全机继续窒息。`oom_reaper` 内核线程（4.11 起）就是为此：**用 `mmap_read_trylock` 抢地址空间读锁，直接 unmap 匿名与私有文件映射**，绕过受害者自己退出；完成后打上 `MMF_OOM_SKIP` 标记，让后续回收不再为这个 mm 等待。

reap 的边界要背下来：**持 mmap_write_lock 的区域（某些驱动/VMA 操作）它拿不到锁，reap 不保证成功**。日志读法：

```text
Out of memory: Killed process 1234 (java) total-vm:...
  anon-rss:... file-rss:... shmem-rss:...
oom_reaper: reaped process 1234 (java), now anon-rss:...
```

没有第二行，说明没 reap 动——释放依赖它自己退出，抖动会比预期长。

## 14.4 容器 OOM 的完整因果

memcg OOM（constraint=MEMCG）与节点 OOM 是两种病：

- **容器 OOM，节点还很空**：limit 问题，查 `memory.max` 与工作集（第 13 章）；K8s 侧表现为 `OOMKilled`、exit code 137。
- **节点 OOM，杀的是容器**：全机超卖，`memory.events`（root）与 dmesg 的 constraint 区分；驱逐（kubelet）与内核 OOM 是两套独立触发器，阈值错位时会出现"该驱逐的没驱逐、先被杀了"。
- `memory.oom.group`（v2）：整组同生共死，适合"杀半残不如全重启"的批任务；默认逐个杀，适合有状态服务。

## 14.5 实验与案例：一次"杀错人"的复盘

实验（测试 cgroup 内，安全做法）：给子组 `memory.max` 设 200MiB，`stress-ng --vm 1 --vm-bytes 300M` 冲顶，读 dmesg 的 constraint、badness 行与 `memory.events` 的 oom_kill 增量——一次跑通就把本节所有字段认全。

**案例：节点 OOM，100GiB RSS 的批处理被杀，但业务损失最大的是被"陪杀"的重启风暴**。证据链：dmesg 显示唯一 constraint=NONE 的全局 OOM，victim 是 badness 最高者；但随后 8 个服务因依赖该批处理的临时文件同时失败。复盘：**全局 OOM 触发说明 memcg limit 总和已经超配**（第 13 章），badness 杀"最大"完全正确；根因是容量规划没有给"最大者之死的外部性"做隔离。修复：批处理容器设 `memory.oom.group` + 独立节点池；关键服务上调 limit 并保留负 adj。**教训：oom_score 规则永远"对"，被杀名单是算术结果——要改的是配额与拓扑，不是追杀的顺序。**

**本章要点：**

- OOM 三门槛：回收做尽、order 不超过 costly order、作用域内有可杀者；高阶失败只 -ENOMEM 不杀人。
- badness 按占用打分，事前可用 /proc/PID/oom_badness 体检；adj 只倾斜不免死。
- oom_reaper 靠 trylock+MMF_OOM_SKIP 抢回内存，但 reap 不保证成功——看第二行日志。
- 容器 OOM 看 constraint：MEMCG 是 limit 病，NONE 是超卖病；驱逐与 OOM 是两套触发器。
- 被杀名单是算术，不是审判：修配额与拓扑，别修打分。

---

# 第 15 章：NUMA - 放置、自动平衡与分层内存

"这台机器还有 100GiB 空闲却在回收"——NUMA 视角下这句话毫不矛盾：**空闲是节点的属性，不是机器的**。本章讲放置规则、两个自动修正器的代价，以及分层内存的新变量。

## 15.1 成本模型先于一切结论

`numactl -H` 给出节点距离矩阵（abstract 值），跨 socket 访存是延迟乘数 + 带宽份额的双重代价，具体倍数强依赖平台（Intel/AMD/ARM、是否 CXL）——**任何"跨 NUMA 慢 N 倍"的数字以本机实测 memory latency/ bandwidth 基准为准**，不存在通用值。运维含义只有一条：跨节点访存的容量规划不能按核数线性推。

## 15.2 默认放置：first-touch 与本地偏好

- **first-touch**：`mmap` 的页在**第一次写入**时分配到执行该次 fault 的 CPU 所在节点。所以"预填充"（memset/`MADV_POPULATE`）在哪个节点跑，页就落在哪个节点——预分配线程池与业务线程池的 NUMA 拓扑不一致，就是"内存先天畸形"的第一现场。
- **本地偏好 + fallback ring**：分配先走本 node 水位（第 5 章的水位是 **per-node** 的），本地不足按距离序降级借用。这解释了经典形态：**node0 水位击穿 kswapd 狂转，node1 空闲一半**——全局 MemFree 很好看。
- 证据入口：`numastat -m`（per-node free/file/anon）、`/proc/zoneinfo` 分 node 水位、`/proc/meminfo` 只是汇总视图。

## 15.3 显式绑定：便宜但两头开刃

`numactl --cpunodebind/--membind`、`mbind/set_mempolicy`（MPOL_BIND 硬约束 / PREFERRED 软偏好 / INTERLEAVE 均摊）、cpuset.mems、K8s Topology Manager 的 single-numa-node 策略。绑定的收益与风险同源：

```text
收益：消除远程访存，大内存数据库可测出两位数量级改善（依平台）
风险一：内存被锁进单 socket——它只能吃一路内存控制器的带宽
风险二：BIND 让本地水位变成"真上限"，超了就回收/OOM，
        而隔壁节点的空闲帮不上忙
```

## 15.4 自动 NUMA 平衡（NUMA balancing）：系统自己搬页

`kernel.numa_balancing`（默认值看发行版）：内核周期性把热点 PTE 改成"假缺页"（NUMA hint），下次访问 trapped 进内核，统计谁在访问、**把页迁到访问者节点**（必要时给任务提迁移建议）。账本在 `numastat` 的 `numa_pte_updates / numa_hint_faults / numa_pages_migrated`。

代价模型：trapping 本身就是软件中断风暴 + 迁移吃 CPU。三类负载上它经常**净亏**：页被多个节点线程轮流访问的共享型进程（数据库 buffer pool、Redis 主从 replicator）、访问局部性本来就好的绑核进程、以及本身在做内存迁移的系统。**案例**：Redis 宿主开启自动平衡后 p99 规律性抖动，`numa_hint_faults` 每秒十万级、migrated 持续增长——页在两个 socket 间来回搬家。修复即关 `numa_balancing`：这不是"功能坏了"，是 hint 机制与共享访问模式天然冲突。判据永远先看账本再下结论，不要凭"听说要关"。

## 15.5 分层内存：TPP 与 demote/promote

CXL 内存与 PMEM 把"节点"变成"层级"。主线方向：**回收路径遇到冷页先"降级"（demote）到慢层而不是换出**，慢层过热页再 promote 回 DRAM（5.10 起降级骨架进入主线，6.x 与 MGLRU 深度结合；接口名与默认值以本机源码/Documentation 为准）。对 SRE 的新问题清单：

- 业务视角的"内存"出现两个价格：容量指标要分层统计（numastat 的层级视图 / 各层水位）。
- demote 与 swap 争夺同一块冷页（第 12 章）：调 `demotion_enabled` 之前先想清楚"降到 CXL"与"换出 zswap"谁更便宜。
- DAMON（第 11 章）的采样结果天然是 promote/demote 的输入，两条线在 6.x 汇合。

## 15.6 案例：双路 MySQL，kswapd 只在一颗 CPU 上忙

现象：node0 的 kswapd 长期 100%，node1 空闲 60%；`numastat -m`：node0 free 贴 min 线，node1 free 过半。证据链：实例 mysqld_safe 启动脚本绑了 node0 的 CPU 但**没绑 mem**，buffer pool 的 128GiB 分配全走本地偏好压在 node0；重启后 first-touch 使畸形固化。根因：**CPU 绑定与内存绑定只做了一个**。修复：`--cpunodebind` + `--membind` 成对出现（或成对绑两个实例各占一路）；存量内存靠自动平衡或重启消化。教训：NUMA 问题九成是"放置"问题，`numastat -m` 两行就能确诊——但修复必须同时回答 CPU 与内存两个绑定。

**本章要点：**

- 空闲与水位是 per-node 属性；first-touch 决定出生地，预填充线程的拓扑决定内存拓扑。
- node0 回收狂 + node1 空 = 放置畸形，numastat -m 两行确诊。
- 显式绑定收益与风险同源：锁进单 socket 的带宽与"本地即上限"的水位。
- NUMA balancing 用 hint fault 换页归位，共享访问型负载上常净亏——看账本再开关。
- 分层内存（demote/promote）与 swap 争同一批冷页，容量指标从此分层统计。

---

# 第 16 章：大页 - hugetlbfs 与 THP 的设计权衡

大页买的是 TLB 覆盖率，卖的是分配延迟与内存粒度。两条路线的设计目标根本不同，混谈"大页有没有用"没有意义。

## 16.1 为什么是页表，不是内存

4KiB 页 × 数 GiB 工作集 = TLB 必然 miss；2MiB 页把同段覆盖率高两到三个数量级，访存的"地址翻译税"随之消失。但同一枚硬币：

- **粒度税**：碰 4KiB 也要付出 2MiB 的分配、清零与驻留（第 7 章的 30-150μs 清零账）。
- **回收粒度**：THP 可拆（split），hugetlb 不可拆——静态预留与动态分配的行为差异全部由此而来。

## 16.2 hugetlbfs：静态预留， explicit 世界

```text
预留池：/proc/sys/vm/nr_hugepages 或
  /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
挂载：  mount -t hugetlbfs nodev /dev/hugepages
使用：  mmap(MAP_HUGETLB) / 文件；DPDK/SPDK/数据库大内存池
统计：  /proc/meminfo 的 HugePages_Total/Free/Rsvd，Hugetlb
```

设计特征：启动早期预留最容易成功（碎片少）；late 分配可能失败，`nr_hugepages` 写了不等于拿得到（回读确认）。**它不参与回收、不可 swap、不计入 MemAvailable**——预留的每一页都是"从全局内存里永久划走的"。超卖与 NUMA：池是 per-node 的（sysfs 层级里能看到），first-touch 同样适用（第 15 章）。适合画像明确的大内存池（JVM `-XX:+UseLargePages`、DPDK）：**用量固定、生命周期长、宁可少用不许抖**。

## 16.3 THP：自动、透明、也自动收税

开关三态（`/sys/kernel/mm/transparent_hugepage/enabled`）：`always`（内核态判断）、`madvise`（显式 `MADV_HUGEPAGE`）、`never`；`defrag` 另有 `always/defer/defer-against-swaps?`（5.9 前后默认从同步整理改为 defer 方向演进，具体值以本机为准）。机制两条：

1. **fault 路径**：缺页时直接尝试 2MiB 分配（GFP_TRANSHUGE），失败按 defrag 策略决定是同步整理、异步整理还是退 4KiB——**抖动就藏在这一步的选择里**。
2. **khugepaged**：后台把散 4KiB 折叠（collapse）成 2MiB，吃 CPU、吃 compaction。

账单入口：`/proc/meminfo` 的 `AnonHugePages`、`/proc/PID/smaps` 的 per-VMA `AnonHugePages`、`/sys/kernel/mm/transparent_hugepage/stats/`（alloc_success/fail、fallback 分布——**fallback 计数是"你付了多少延迟换 4KiB"的直接证据**）。

THP 的四个隐性代价：分配尾延迟（defrag 同步等待）、fork 的 COW 粒度放大（2MiB 起拷）、RSS 口径（未触及子页是否按整块计，历史上随版本与 huge zero page 变化，**以本机实测 VmRSS 为准**）、回收时 split 的额外开销。

## 16.4 always / madvise / never：决策表

```text
场景                        推荐          理由
低延迟敏感 KV/缓存(Redis)    never/madvise 清零与 COW 尖刺不可接受
大内存稳定池(JVM/DB 大 buffer) madvise 或 hugetlb 收益真实且可控
高密度虚拟化/桌面            never         内存碎片与回收复杂度
新平台不确定                先 never 基线  再灰度 madvise 对照收益
```

判据全部回到数字：`AnonHugePages` 增速、`stats` 的 fallback、业务 P99 与 `compact_stall` 的同窗性。**"THP 导致毛刺"与"THP 提升吞吐"都是真的——负载画像决定哪一条真**，A/B 是唯一裁判。

## 16.5 案例：缓存集群的"玄学抖动"

某 Redis 集群随机实例 P99 每数分钟上跳。证据链：毛刺时刻 `compact_stall` 计数跳升，`AnonHugePages` 同步增长；`thp_stats` 的 collapse 计数在 khugepaged 唤醒窗口集中。机制：always 模式下 khugepaged 对写密集大 heap 做折叠，每次折叠伴随 2MiB 分配 + 清零 + 页表改写。修复：该组实例改 `madvise`（Redis 本身不调用 madvise，等效关闭），毛刺消失，吞吐回正。**这不是 THP 的 bug，是折叠成本按设计出现在不该出现的时间窗**。

**本章要点：**

- 大页买 TLB 覆盖率，卖分配延迟与驻留粒度；收益与代价都由页大小决定。
- hugetlbfs 静态预留：不回收、不 swap、不入 MemAvailable，写了 nr_hugepages 不等于拿到。
- THP 两条税路：fault 时的同步 defrag 与 khugepaged 的后台折叠，fallback/stats 是账本。
- always/madvise/never 选择看负载画像，不看博客；A/B 用 P99+compact_stall+AnonHugePages 三联判据。
- RSS 与清零粒度随版本演进（huge zero page 等），大页结论必须绑定内核版本。

---

# 第 17 章：观测、诊断与案例 - 从 /proc 到 PSI 的因果链

前 16 章的机制最终都要落到"看什么数"。本章不是命令集锦，而是一张**分诊图**：每个数字回答哪一个问题、每个问题该去哪个接口取证。

## 17.1 /proc/meminfo 的口径总表（易错项优先）

| 字段 | 口径要点 | 常见误读 |
|---|---|---|
| MemFree | buddy 空闲，不含可回收 | 当"可用"看，永远比体感少 |
| MemAvailable | 启发式估算（第 8 章） | 当精确预算用 |
| Buffers | 块设备元数据页 | 与 Cached 混谈 |
| Cached | page cache，**含 tmpfs** | 高不代表"白占"，但 shmem 丢不掉 |
| AnonHugePages | THP 驻留量（第 16 章） | 增长即坏？看毛刺同窗性 |
| Slab | SReclaimable+SUnreclaim（第 6 章） | "Slab 高"是两个不同的病 |
| Dirty/Writeback | 第 9 章的锯齿 | 单点值无意义，看曲线形态 |
| Committed_AS/CommitLimit | overcommit 账（第 3 章） | 与真实占用无关 |

## 17.2 分诊：PSI 是第一刀

`/proc/pressure/{memory,io,cpu}` 三文件 × 两行（some/full）× avg10/60/300。读法：

```text
memory some 高、full 低   部分任务在等内存：回收/throttling 常态
memory some+full 同高      全员窒息：贴近 OOM（第 14 章）
io some 高                 有人在等回写/换页：对照 9/12 章管道
cpu some 高                有人在等 CPU：留给 CPU 篇的主战场
```

PSI 是**分诊器不是诊断器**：它回答"痛在哪类资源、痛到什么程度"，根因仍需第二刀。

## 17.3 第二刀：回收面板定位机制（第 5/10 章复用）

```text
pgscan_direct 高       水位失守 → 查碎片(第5章)与 memcg 保护(第13章)
workingset_refault 高  回收错杀 → 容量或冷热失真(第10/11章)
compact_fail 与        碎片固化 → migratetype 与 min_free_kbytes(第5章)
  compact_success 比
si/so 与 PSI memory     swap 泄压开闸 → 第 12 章判读模板
major fault 增速       等待 IO 的缺页 → 文件/swap 二选一(第7章)
```

## 17.4 第三刀：who → what → where

- **who**：容器级 `memory.stat` 分组账 + `memory.events`（第 13 章）；进程级 `smaps_rollup`（Rss/Swap/Pss 口径——K8s 用 working set 而非 PSS 的原因第 13 章已给）。**smaps 取 mmap 读锁、大 RSS 进程上代价高**，监控 agent 用 rollup 并降频，这本身就修掉过一类"采集引发毛刺"的事故（第 7 章锁史）。
- **what**：`slabtop`/`/proc/slabinfo`（第 6 章两本账）、per-VMA 的 `AnonHugePages`/`VmFlags`（第 16 章）。
- **where**：`numastat -m`（第 15 章）、per-node `zoneinfo` 水位、bpftrace/bcc 工具箱（cachestat 命中率、memleak 分配栈）——**上生产前在测试机验证探针开销**，这是全篇所有"直接看"能力的共同前提。

## 17.5 案例集：五证合一

**案例 A：MemAvailable 还有 30GiB，写入却持续抖动。** PSI memory some 高；`pgscan_direct` 增长、`buddyinfo` 高阶列全零、`pagetypeinfo` 显示移动类型污染。机制：第 5 章碎片三联征——"量够、连续性不够"。修复：proactive compaction + 提高 min_free_kbytes，抖动与 compact_success 同时消失。

**案例 B：容器 RSS 只有 2GiB，limit 3GiB 却 OOM。** dmesg constraint=MEMCG；`memory.stat`：anon 2GiB + **pagetable 600MiB + file 700MiB**（大 mmap 文件 + 页表账）。机制：第 13 章"账本内存"。修复：limit 按账本重算；页表大头考虑合并映射区（第 4 章）。

**案例 C：监控采集时段服务 P99 上跳。** 采集读全量 smaps（非 rollup）持 mmap 读锁秒级，业务 fork/mmap 写锁排队（第 7 章）。修复：改 rollup + 降频，同窗 PSI 归零。

**案例 D：迁移后业务 CPU 高内存没满。** `memory.events` 的 high 持续增长、`memory.pressure` 抖动同窗。机制：第 13 章 memory.high 收税。修复：high 上调至工作集之上。

**案例 E：node0 kswapd 满载、node1 空闲。** `numastat -m` 两行确诊（第 15 章）。根因：CPU 绑定没配内存绑定。修复：cpunodebind 与 membind 成对。

五个案例的共同结构：**现象 → PSI/计数器分诊 → 面板定位机制 → 账本定位对象 → 实验或日志定案**。缺任何一环，结论就退化成经验性归因。

## 17.6 全篇收尾：一句话版本

- 物理层：buddy 管连续、slab 管碎片、水位管余量（2-6 章）。
- 映射层：页表管地址、TLB 管翻译、fault 管按需（3/4/7/16 章）。
- 缓存层：page cache 管复用、回写管还债、LRU/MGLRU 管遗忘（8-11 章）。
- 治理层：memcg 管分账、OOM 管平仓、NUMA 管放置、PSI 管疼痛（12-17 章）。

数字不会说谎，但口径会用错——每个结论都要有自己的第一手接口。

**本章要点：**

- meminfo 每个字段都有陷阱口径：先背表，再谈容量。
- PSI 分诊、回收面板定位机制、账本文件定位对象——三刀流顺序不可颠倒。
- smaps 是锁资源：rollup + 降频既是省钱也是避雷。
- 五类高频故障（碎片/账本/采集/high 税/NUMA）各自的第一手证据入口要能默写。
- 因果链思维替代经验归因：现象→分诊→机制→对象→定案，缺一环不下结论。
