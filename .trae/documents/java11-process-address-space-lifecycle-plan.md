# 【Linux】Java11 应用进程内存地址生命周期管理 - 写作计划

## Summary

在 Hexo 博客中撰写一篇 **15 章 / 3000 行以上** 的深度技术长文，主线是 **Linux 进程地址空间从诞生到销毁的完整生命周期**（`execve` 建立 `mm_struct` → ELF 装载初始 VMA → `mmap/brk` 开辟 → 缺页提交物理页 → `mprotect/madvise/munmap` 状态迁移与归还 → `exit_mm` 销毁），并在 **每一个生命周期阶段用 Java 11 HotSpot JVM 的真实行为作为落地实例**（Reserved/Committed/Used 三层语义、G1 Region commit/decommit、Metaspace chunk 池、CodeCache、线程栈 guard page、DirectByteBuffer 记账）。

目标文件：`d:\pozicaiman.github.io\source\_posts\【Linux】Java11 应用进程内存地址生命周期管理.md`（当前为空文件，0 行）。

## Current State Analysis

**仓库环境**
- Hexo 8.1.2 + 自研 `indigo` 主题，`source_dir: source`，`public_dir: docs`，`permalink: :year/:month/:day/:title/`
- 渲染器：`hexo-renderer-marked`（CommonMark），语法高亮 `highlight.js`（`line_number: true, wrap: true`）
- `scripts/protect-math.js` 在 `before_post_render` 把 `$...$` / `$$...$$` 整段 hex 编码为占位符，`after_post_render` 还原 —— 因此 MathJax 公式可用，但**同一行内出现两个裸 `$` 会被当作公式配对**（例如 `awk '{print $2}'` 与另一处 `$1` 同行），成稿时须避免同一行多个 `$`，公式只在正文少量使用。
- 无 mermaid 渲染插件（`package.json` 未安装），姊妹篇三篇长文全部使用 **```text 围栏内的 ASCII 框图**，因此本文一律用 ASCII 图，禁止引入 mermaid 代码块。

**同系列文章与本文边界**

| 已有文章 | 行数 | 已覆盖内容 | 与本文重叠度 |
|---|---|---|---|
| 【Linux】系统内核基础结构分析.md | 3442 | 第 5 章为入门级虚拟内存/4 级页表/伙伴+slab/页面缓存/OOM/大页 | 低（仅科普层，无 `mm_struct`/VMA/缺页路径/销毁路径） |
| 【Linux】系统内存分配应用分析.md | 2204 | ptmalloc2 arena/chunk、JVM/Go/Python/Node 运行时内存模型、page fault 统计、cgroup 计费、smaps/perf/eBPF 工具、5 个案例 | 中（分配器视角；本文是**地址空间视角**，需显式避免重复讲 chunk/arena 内部结构） |
| 【Linux】Java11虚拟机系统配置指南.md | 2223 | JVM 内存模型图、JVM 参数、G1 调优、NMT 与 RSS、GC 日志、jcmd/jmap 工具链、容器配置、案例 | 中（参数与 GC 视角；本文不讲 GC 算法与调优参数细节，只讲各区域**如何映射到内核地址空间生命周期**） |

**本文的差异化定位（必须贯穿全文）**：把虚拟地址空间当作**有状态、有生命周期的资源**来讲解 —— 记账本（`mm_struct` / VMA / 页表 / cgroup）× 时间轴（诞生 → 开辟 → 提交 → 迁移 → 退场 → 销毁）。所有 JVM 内容都是这条时间轴上的实证样本。

**写作风格约定（从姊妹篇逐条提取）**
1. Front matter：`---` 包裹 YAML，字段顺序 `title / date / categories / tags`
2. 正文可选开篇 `> 本文从…` 引导块（见内核基础篇第 8 行）
3. 标题层级：`# 第 N 章：标题`（中文全角冒号）、`## N.M 标题`、`### N.M.K 标题`
4. 每章结尾固定输出 `**本章要点：**` + 3-6 条 `-` 列表；章与章之间用单独一行 `---` 分隔
5. 关键结论用 `> **关键认知**：…` 引用块
6. 图：```text 围栏内 ASCII 框图（`┌ ─ ┐ │ ├ ┤ └ ┘ ↓ ↑ ← →`），必须逐行对齐
7. 命令示例：```bash，输出以 `#` 注释形式紧跟其后；内核代码片段用 ```c 并标注 `mm/mmap.c`、`fs/exec.c`、`memory.c` 等源文件路径；JVM 片段用 ```cpp 标注 `os_linux.cpp`、`virtualSpaceNode.cpp` 等
8. 案例固定模板：`### 现象 / ### 假设 / ### 证据采集 / ### 根因 / ### 修复 / ### 验证`
9. 对比信息用 Markdown 表格
10. 版本口径：内核统一写 **Linux 5.10 / 5.15 / 6.6 LTS** 差异（VMA 组织：rbtree → Maple Tree 为 6.1 分界；per-VMA locks 为 6.5；`process_madvise` 为 5.10）；JVM 统一写 **OpenJDK 11.0.x HotSpot**

**Front matter 定稿**

```yaml
---
title: Java 11 应用进程内存地址生命周期管理：从 execve 到 exit_mm 的完整工作原理
date: 2026-10-01 10:00:00
categories: [操作系统]
tags: [Linux, 内核, 内存, JVM, Java, 性能优化]
---
```

- `date` 接续系列时间线（内核基础 09-30 14:00 → 内存分配 09-30 16:00 → JVM 配置 09-30 18:00 → 本篇 10-01 10:00），确保首页按 `-date` 排序时本篇位于最前
- `categories: [操作系统]`：主线是内核机制（与《系统内存分配应用分析》同类），JVM 作为实证；`[Java]` 类目已被配置指南篇占用

## Proposed Changes

只新增一个文件的正文内容（不改动 `_config.yml`、主题、脚本、其他文章）。全文 15 章，逐章规格如下。

### 第 1 章：引言 - 把地址空间当作有生命的资源（~220 行）

- 1.1 一条时间轴：`java -jar app.jar` 到进程退出，地址空间经历的 6 个阶段（诞生/开辟/提交/迁移/退场/销毁），ASCII 时间轴图
- 1.2 "开辟内存地址空间"的三层含义：Reserved（VSZ/`total_vm`）→ Committed（Overcommit 记账/`VmData`）→ Resident（RSS/`Private_Dirty`），一张三层同心框图 + `grep -E 'VmPeak|VmSize|VmRSS|VmData|RssAnon' /proc/pid/status` 实测输出
- 1.3 为什么 `-Xmx8g` 的进程 VSZ 会到 20g+：`mmap PROT_NONE` 预留与缺页提交的解耦（前置悬念，第 4、8 章解开）
- 1.4 本文与系列另外三篇的分工表（读者导航，明确不重复讲什么）
- 1.5 读者与前置知识（进程/页表基础概念即可，第 2 章补齐数据结构）
- 阅读地图：15 章按生命周期阶段分组的 ASCII 结构图

### 第 2 章：数据结构底座 - mm_struct、VMA 与页表（~330 行）

- 2.1 `mm_struct` 逐项拆解（`include/linux/mm_types.h`）：`mmap`/`mm_mt`、`pgd`、`brk/start_brk`、`start_code..end_stack`、`total_vm/reserved_vm/locked_vm`、`map_count`、`context`+`cpu_bitmap`（TLB 世代）、`write_protect_seq`、`def_flags`、`owner`。ASCII：mm_struct 字段与 `/proc/pid/status` 字段的映射关系
- 2.2 `vm_area_struct`：`vm_start/vm_end/vm_flags/vm_page_prot/vm_pgoff/vm_private/vm_ops/anon_vma/vm_file/vm_rb_h/vm_rb_left`；`VM_READ|VM_WRITE|VM_EXEC|VM_MAY*` 位与 `rwxp` 字符串的双向换算表
- 2.3 VMA 组织方式演进：单链表（2.6 前）→ rbtree + 链表（3.0）→ `anon_vma` rbtree（4.x）→ **Maple Tree（6.1+，`mm->mm_mt`）**；说明 `vm_area_struct` 在 6.x 的 `MAPI_*` state、`vm_flags` 改为 64 位、`vm_start/vm_end` 移入 `__vm_start/__vm_end` + `MAPI_STATE`；对 `procmem`/eBPF 读取 VMA 的影响（`bpf_iter_task_vma`）
- 2.4 页表四/五级：x86-64 4 级与 LA57 5 级、aarch64 4 级；页表页本身也是内存（`pgtable_page_ctor`），一张 PGD→P4D→PUD→PMD→PTE 树图 + 一个大堆 JVM 的页表元数据开销估算表（8g 堆：PTE 层 8MB 元数据；2MB 大页省掉 PTE 层）
- 2.5 用户态地址空间布局：`TASK_SIZE`(0x7fffffffffff) / `[stack]` 向下 / `mmap_base`（`MMAP_BASE_RANDOMIZATION`、top-down 分配）/ `[heap]` 向上 / `ET_EXEC` 代码段 / `[vsyscall] [vvar] [vdso]`；`vm.mmap_min_addr`、`vm.legacy_va_layout`、`kernel.randomize_va_space=2` 对每段的作用；ASCII 完整布局图（标注 JVM 常用落点）
- 2.6 `/proc/pid/maps` 的生成路径：`proc_maps_open` → `seq_ops` → `show_map_vma` → `vm_flags_to_sproc`；解释 `[heap]`/`[stack]`/`[anon]`/`[vdso]` 标签来源与 `pmap -x` 的差异
- 2.7 三本账本的心智模型：`mm_struct`（虚拟）× 页表（映射）× cgroup（物理计费）

### 第 3 章：生命周期起点 - 进程创建与地址空间诞生（~300 行）

- 3.1 `fork`/`vfork`/`clone` 三态对比：`kernel_clone` → `copy_process` → `copy_mm` → `dup_mmap`；`CLONE_VM` 有无决定"新地址空间 vs 共享线程"
- 3.2 `mm_alloc` / `mm_init` / `alloc_mm_pgdir`：`mm_struct` 从 `mm_cachep` slab 取对象、`pgd` 从 `pgd_cache`/`__pgd_alloc`、`MMF_*` 标志初始化（`MMF_MAP_COALESCE`、`MMF_HAS_UPROBES`）、`membarrier_register_mm_expedited`
- 3.3 `execve` 的"重生"：`do_execveat_common` → `bprm_mm_init`（新 mm + 初始 stack VMA）→ `search_binary_handler` → `load_elf_binary` → `begin_new_exec`（`exit_mmap` 旧 mm、`task_size` 重置、`arch_pick_mmap_layout`、`randomize_elf_stack`、`setup_new_exec`）→ `free_bprm`。ASCII：fork 复制路径 vs execve 替换路径两条泳道
- 3.4 ELF 装载建立初始 VMA 矩阵：`ELF_HDR`/`PT_LOAD` 段 → `elf_map`（`MAP_PRIVATE` file-backed）→ `load_elf_image` 处理 `p_memsz > p_filesz` 的 `.bss` 匿名尾巴 → `set_brk` 确定堆起点 → `PT_GNU_STACK` 决定栈是否可执行（`READ_IMPLIES_EXEC`）→ `PT_INTERP` 装载 `ld.so` → `mapvdso`。附一份 `readelf -l /bin/java` 输出与 maps 初值的对照
- 3.5 PIE/ASLR 与地址随机化的落地时机：`arch_randomize_brk`、`randomize_stack_top`、load_base 计算；`check_bytes`/`ELF_RANDOMIZE`
- 3.6 **Java 11 实证**：`/bin/java` 是 20KB 的 `java.c` launcher 可执行文件 → `execve` 后早期 maps 快照（只有 `libjvm.so`、`libc`、`libjli` 等 file-backed 段 + 一小块堆），**此时 `-Xmx` 尚未生效**；`JLI_Launch` → `JNI_CreateJavaVM` 才触发第 4 章的预留。附 `strace -f -e trace=mmap,brk,futex -p <pid>` 启动期片段
- 3.7 线程（`clone3`/CLONE_VM）与地址空间：`libpthread` 用 `mmap` 分配线程栈 + `PROT_NONE` guard page；Java 每个 `Thread` = 一个 `pthread` = 一块 mmap 栈，`mm->map_count` 随之增长（引出 12.2 案例的 `vm.max_map_count`）

### 第 4 章：第一次"开辟" - mmap/brk 与 VMA 插入（~330 行）

- 4.1 `do_mmap` 完整路径拆解（`mm/mmap.c`）：`accountable_mapping` → `get_unmapped_area` → `vma_prepare`/`do_vmi_align_munmap`（重叠区域）→ `mmap_region` → `vma_set_anonymous`/`set_page_flags` → `call_mmap`（`file->f_op->mmap`）→ `vma_link`/`insert_vm_struct` → `vm_stat_account(VM_TOTAL_VM)`。ASCII：一次 mmap 从系统调用到 VMA 插入的调用链竖图
- 4.2 空闲区域查找：`get_unmapped_area` → `arch_get_unmapped_area_topdown`（`MMAP_BASE` 往下扫 `find_vma` + `hi = vm_start - len`）vs `legacy_bottom_up`；`MAP_FIXED`/`MAP_FIXED_NOREPLACE`(4.17) 的破坏性与安全用法；hugepage 对齐 `hpva_align`
- 4.3 关键 flag 语义与后果表：`MAP_ANONYMOUS`、`MAP_PRIVATE`/`MAP_SHARED`、`MAP_NORESERVE`、`MAP_POPULATE`、`MAP_HUGETLB`、`MAP_UNINITIALIZED`、`MAP_GROWSDOWN`（栈自动增长的现代限制 `stack_guard_gap`）、`PROT_NONE`（预留的惯用手段：占地址、不记账、不可访问）。重点讲 `PROT_NONE + MAP_NORESERVE` = HotSpot `reserve_memory` 的实现基础
- 4.4 `brk` 路径：`sys_brk` → `__do_munmap`(收缩) / `expand_downwards`(增长) → `mm->brk` 更新；`MADV_WILLNEED` 无关；解释为何现代 JVM 几乎不用 `brk`（`glibc` 的 `M_MMAP_THRESHOLD=128KB`、`main_arena` 只在启动期扩 brk），`pmap` 中 `[heap]` 常年停留在几 MB
- 4.5 Overcommit 记账：`__vm_enough_memory` 三档 `vm.overcommit_memory=0/1/2`、`overcommit_ratio`、`totalram_pages + total_swap_pages` 基线、`Committed_AS`、`MAP_NORESERVE` 与 `accountable_mapping` 的豁免逻辑、`mem_cgroup` 侧不计 reserve 只计 fault-in；给出 `python3 -c` 或 `stress-ng --vm` 演示"预留成功、缺页才失败"的现象（`Cannot allocate memory` 出现在 touch 阶段）
- 4.6 **Java 11 实证**：`os::Linux::init_system_memory` / `PosixVirtualMemoryPath::reserve_memory_special`（`-XX:+UseCompressedOops` 下 `AllocateHeapAt`、大堆用 `mmap(PROT_NONE)` 一次预留）；`-XX:+AlwaysPreTouch`（改走 `MAP_POPULATE` 或逐页 touch）；`-XX:+ReduceProcessMemory`（JEP 351，11 引入的 THP `MADV_PAGEOUT` 式缩减，实际 14+ 才成熟，需注明）；一张 `java -Xms8g -Xmx8g` 的 `grep -c '' /proc/pid/maps` 与 `VmSize` 前后对比表
- 4.7 HotSpot 内存抽象四件套：`VirtualSpace` / `VirtualSpaceNode` / `PosixVirtualMemoryPath` / `ReservedMemoryRegion`，`virtualSpaceNode.cpp` 的 `VirtualSpaceNode::initialize`（一次 mmap 预留 + 按 `chunksize` 分段 commit）、`release`（munmap）、`grow`；`os::reserve_memory` vs `os::commit_memory`（`mprotect(PROT_READ|PROT_WRITE)`）vs `os::uncommit_memory`（`madvise(MADV_DONTNEED)` + `mprotect(PROT_NONE)`）三个函数的源码要点 —— 这是全文最重要的"JVM ↔ 内核"对应表

### 第 5 章：虚拟到物理的点火 - 缺页异常与按需分页（~300 行）

- 5.1 硬件到软件的完整链路（x86-64）：`#PF` → `exc_page_fault` → `no_context`/`bad_area` → `mm_fault_error`；`error_code` 位（P/W/U/RS/ID/PROTECTION_KEY）与 `si_code`（`SEGV_MAPERR` vs `SEGV_ACCERR`）→ 为什么 `PROT_NONE` 预留区被误写会报 `SEGV_ACCERR`
- 5.2 分类矩阵：匿名 vs 文件、minor vs major、COW、`NUMA missing`（`knumad`/`numa_balancing`）、`swap in`、`userfaultfd`、`KSM`；`min_flt`/`maj_flt`（`/proc/pid/stat` 第 12/14 字段）与 cgroup `memory.stat`、`/proc/vmstat` 的 `pgpgin`/`pgfault`/`pgmajfault` 对应
- 5.3 `handle_mm_fault` → `__handle_mm_fault`（PUD/PMD 分配、`vmf->origng_mask`）→ `handle_pte_fault` 的分支树：`!vmf->pte` → `do_anonymous_page`（零页优化 `ZERO_PAGE`、`anon_vma_prepare`、`set_pte_vma_lock`）/ `do_fault` → `wp_page_copy`（COW）/ `do_swap_page`；`FAULT_FLAG_WRITE|FAULT_FLAG_ALLOW_RETRY|FAULT_FLAG_KICK_MM`；`VM_FAULT_*` 返回值（`RETRY`/`NOPAGE`/`OOM`/`SIGBUS`/`VM_FAULT_ERROR`）
- 5.4 锁与并发演进：`mmap_lock`（原 `mmap_sem`，5.8 改名，读锁多写锁少）→ **per-VMA locks（6.5，`vma_start_write`/`vma_end_write_all`，`VMA_FLAGS_POPULATE`）**；`fault-around`（`fault_around_bytes=64KB`）对 JVM 预触碰的实测意义；`page fault` 的 cost 拆解（TLB miss 计数、`perf c2c`）
- 5.5 `madvise(MADV_POPULATE_READ/WRITE)`（5.14）与 `MAP_POPULATE`、`mlock`/`mlock2`/`MLOCK_ONFAULT`、`process_vm_fault` 的差异；`vm.max_map_count` 与 fault 时 VMA 查找成本（`mmap_find_vma` 在 Maple Tree 下 O(log n)）
- 5.6 **Java 11 实证**：堆首次触碰的 page fault 风暴量化（8GB 堆 / 4KB 页 = 约 209 万次 fault；单次约 1-3μs → 2-6 秒启动预热）；`-XX:+AlwaysPreTouch` 前后 `pgfault` 计数与首笔请求 P99 对比表；G1 `uncommit` 后再 commit 的 **二次缺页代价**（这是"GC 归还内存换回延迟"的物理根源，13.4 章给决策树）；`-Xlog:gc+heap=debug` 的 region 状态（`F`/`E`/`O`/`H`/`F`）与 VMA 可见性的关系（JVM 内部 region 不产生独立 VMA，整堆仍是一个 VMA —— 关键认知）
- 5.7 大页与 fault：`transparent_hugepage=always/madvise/never` + `defrag` 策略、`/sys/kernel/mm/transparent_hugepage/hpage_pmd_size`、`AnonHugePages`、`thp_allocation` 直接回收导致的 100ms 级抖动（引用《系统内存分配应用分析》7.4 案例不复述，此处只补 THP 与 fault 路径的代码交互 `do_set_pmd`/`vm_normal_page_pmd`）

### 第 6 章：commit 的落地层 - 物理页分配与页表元数据（~280 行）

- 6.1 `alloc_pages` → `__alloc_pages_nodemask`：fast path（`get_page_from_freelist`）→ slow path（`__alloc_pages_slowpath`：唤醒 kswapd、direct reclaim、compaction、nofail）；order-0 与 order>0 的分野
- 6.2 `gfp_mask` 与进程上下文对照表：`GFP_USER`/`GFP_HIGHUSER_MOVABLE`（用户匿名页）/`GFP_KERNEL`/`__GFP_RECLAIM`/`__GFP_IO`/`__GFP_FS`/`__GFP_NORETRY`/`__GFP_NOWARN`/`__GFP_MOVABLE`/`__GFP_COMP`；为什么匿名页要 `MOVABLE`（compaction 与 MIGRATE_TYPES）
- 6.3 zone / watermark / fallback：`ZONE_DMA`/`DMA32`/`NORMAL`/`MOVABLE`，`min/low/high watermark`、`WMARK_QUANTUM`、`node_reclaim`；NUMA 策略 `MPOL_DEFAULT/BIND/INTERLEAVE/PREFERRED` + `set_mempolicy`/`mbind`；`numa_balancing`（AutoNUMA）迁移页对 JVM 的影响（`/proc/pid/numa_maps` 的 `N0=/N1=`）
- 6.4 页表内存自身的管理：`pgtable_pmd_page_ctor`、x86 的 `pgd_cache`/`pmd_table` 分配、4 级页表覆盖 1 个 2MB 区间需要 1 个 PTE 页（4KB）→ **页表元数据开销计算**：`元数据 ≈ RSS/512`；用 `smaps` 的 `PageTables` 字段实测一个 8g Java 进程（约 16MB）；5 级页表与 `LA57` 的额外一层
- 6.5 反向映射（rmap）与 `anon_vma`/`anon_vma_chain`：为什么一个 VMA 需要一个 `anon_vma` 树、`folio_mk_anon`、页面回收时 `try_to_unmap` 遍历 rmap 的成本（大堆 JVM 回收扫描慢的结构性原因之一）；`anon_vma` 的 `degree` 分裂（`ANON_VMA_CHAIN`）
- 6.6 **Java 11 实证**：`-XX:+UseLargePages`（透明 vs 显式 hugetlb：`/proc/sys/vm/nr_hugepages`、`Hugepagesize`、`/sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages`、容器内需 `hugepages limits`）、`-XX:LargePageSizeInBytes`；显式 hugetlb 走 `hugetlbfs` + `mmap` 路径（`HPAGE` VMA、页表在 mmap 时即建立、**无按需缺页代价、不可 swap、不可回收** —— 与 commit 生命周期对应的取舍表）；`UseLargePagesInMetaspace`（Java 11 存在但需 `ReduceMetaspaceWithSharing` 语境，注明限制）；`VmFlags` 中 `hg`/`mh`/`nh` 的识别

### 第 7 章：状态迁移 - 保护、提示与"退场但不消失"（~280 行）

- 7.1 `mprotect` → `do_mprotect_pkey` → `change_protection_range` → `change_pte_range`：`VM_READ/WRITE/EXEC` 位更新 + 页表 `PTE` 属性改写 + **`tlb_flush_mmap`/`flush_tlb_mm_range` 的必要性**（`mm->context` 世代递增）；`pkey`（5.11）简介
- 7.2 `madvise` 家族逐个讲清"地址空间留下什么、物理页归还什么"：
  - `MADV_DONTNEED`：立即 `zap_page_range`，**VMA 保留、页表清空、下次访问重新缺页且内容变为零**（HotSpot uncommit 的实现）
  - `MADV_FREE`（4.5）：惰性回收，页标 lazyfree、可被写回、`/proc/pid/smaps` 中 `LazyFree` 计数，K8s `memory.reclaim` 场景
  - `MADV_PAGEOUT`（5.4）：强制换出/回收，`-XX:+ReduceProcessMemory` 语义近亲
  - `MADV_COLD`（5.15）、`MADV_WILLNEED`、`MADV_HUGEPAGE/NOHUGEPAGE`、`MADV_MERGEABLE`（KSM，容器多副本 JVM 去重）、`MADV_POPULATE_READ/WRITE`（5.14）、`MADV_DONTFORK`（5.10，与 RDMA/pin 相关）
  - 对比表：`是否释放物理页 / 是否保留 VMA / 是否清零 / 触发时机 / RSS 下降可见延迟`
- 7.3 `process_madvise`（5.10，`syscalls` + `iovec`，`MADV_*` 跨进程批量提示）与 cgroup v2 `memory.reclaim`：容器内 sidecar 对 Java 进程做 `MADV_COLD` 的工程做法与风险
- 7.4 `mremap`（`MREMOVED`/`MREMAP_MAYMOVE`/`MREMAP_FIXED`/`MREMAP_DONTUNMAP`(5.7)）：G1/ZGC 的对象移动是否用 `mremap`（**答案：HotSpot 堆内对象移动是用户态 `memcpy` + 页表更新，不用 `mremap`；但 `-XX:+UseTransparentSerialGC`/`Space` 扩容与 `Metaspace` 的 `VirtualSpace::expand_by` 走 commit 增长**）；`mremap` 在 `mremap_to` 下 `move_vma`（`remove_vma` + `insert_vm_struct`）与 rmap 更新；`mremap` 是"改地址不改物理页"的少数手段（`-XX:AllocateHeapAt` 与 `MapleTree` 时代重定位大段的可行性讨论）
- 7.5 **Java 11 实证**：一个 8G G1 堆在"低峰"的 maps 快照，展示 `rw-p` 与 `---p` 混合的 VMA 布局（uncommit 后 `---p` 出现）；`-XX:MinHeapFreeRatio`/`MaxHeapFreeRatio`（ParallelGC 的堆收缩触发器）与 `G1PeriodicGCInterval`/`G1PeriodicGCSystemLoadThreshold`（11.0.x 已支持，12.0 完善）触发的**周期性 uncommit**；`-XX:SoftMaxHeapSize` 语义（G1，提交量可超软上限但优先收回）；`-XX:+ShrinkHeapInSteps` 类参数不适用于 11，需注明版本边界
- 7.6 `msync`/`mlock`/`munlock`/`mincore` 对实时性的作用（`-XX:+UseMembar`、`mlockall` 让 JVM 堆常驻、`RLIMIT_MEMLOCK` 与容器 `CAP_IPC_LOCK`）

### 第 8 章：JVM 视角的"开辟—提交—归还"闭环（~380 行，本文特色章）

- 8.1 三层语义精确映射表：`Reserved → VmSize/total_vm`，`Committed → VmData/Overcommit 记账`，`Resident → VmRSS/Private_Dirty`，`Used → JVM 内部计数器`；一张四层堆叠图 + NMT `Total reserved committed` 与 `smaps_rollup` 字段并排对照表（同一进程同一时刻的两种视图）
- 8.2 `VirtualSpace` 机制：`reserved_bottom/reserved_top/committed_end`、`VirtualSpaceNode` 的 `reserved_words/committed_words` 位图（chunk 粒度 commit 记账）、`expand_by`/`shrink_by`；说明 `os::commit_memory` 内部实际调用 `mprotect` 还是 `mmap` 取决于是否已有 VMA（`reserve_memory_special` 路径）
- 8.3 **Java Heap**：`Universe::initialize_heap` → `G1CollectedHeap::initialize` → `_reserved = VirtualSpace::create_reserved(...)` → `TryToReserveSpace` → `initialize_mc` 逐 Region commit；G1 的 Region 大小（`-XX:G1HeapRegionSize=1m..32m`，`HeapRegionSizeGrain`）、`Full region/E`/`H` 状态机、`-XX:G1PeriodicGCInvokesConcurrent`；Humongous 对象跨 Region 与 `MADV_DONTNEED` 无独立 VMA 的观测难点
- 8.4 **Metaspace**：`Arena` → `Chunk`（`ChunkManager` 的 `specialized/small/medium/humongous` 四池）→ `VirtualSpaceList`（`Metachunk` 预留）→ `VirtualSpaceNode` commit；`-XX:MetaspaceSize`（首次 GC 阈值，非分配阈值）、`-XX:MaxMetaspaceSize`、`-XX:MinMetaspaceFreeRatio`、`-XX:MaxMetaspaceFreeRatio`、`-XX:MetaspaceReclaimPolicy=balanced/aggressive/conservative/onlife/off`（JDK 11u 后续版本引入，注明）；`MetaspaceGC::inc_capacity`、**Uncommitter 线程**（`MetaspaceGC::compute_new_size` → `shrink_free_chunk` → `release`/`madvise`）；类加载器与 `ClassLoaderData` 的 chunk 归属；实测：`jcmd <pid> VM.metaspace`（11 无此子命令，用 `GC.class_stats`/NMT `Uncommitted` 计数替代，须写清版本可用性）
- 8.5 **CodeCache**：`-XX:ReservedCodeCacheSize`（默认 240MB，`SegmentedCodeCache` 三段：`Profiled nmethod 64m / NonProfiled nmethod 148m / Non-nmethod 2m + 32m`，`-XX:-SegmentedCodeCache` 单段）、`CodeCache::initialize` → `heap->reserved_space()`、nmethod 的 `CodeBlob` 分配与 `flush`（`-XX:+UseCodeCacheFlushing`）、`-XX:-TrimInterpreterGCMap`；**代码段的 `mprotect` 关键性**：JIT 写码时需要 `rwx` 或 `W^X` 交替（`os::make_executable` → `mprotect(PROT_EXEC)`），引出 `SELinux`/`PaX` 与容器 `noexec` 挂载对 `exec` VMA 的影响（`semanage`/`allow_execstack`）
- 8.6 **线程栈**：`-Xss`/`ThreadStackSize` → `os::create_thread`（`pthread_attr_setstacksize`，glibc 用 `mmap PROT_NONE guard + rw` 两段）→ `guard 1 page`（默认 `os::Linux::_page_size`，`-XX:StackGuardPages`）→ 线程退出后 glibc 的 `stack_cache` 复用（`__free_libc_stack`、`PTHREAD_STACK_MIN`）导致 `map_count` 不下降；400 线程 × 1MB 的地址空间成本 vs 实际 RSS 成本对照
- 8.7 **DirectByteBuffer / Unsafe**：`Bits.reserve_memory` 用 `_reserved_memory` 原子计数器记账（`-XX:MaxDirectMemorySize` 默认 = `-Xmx`），`Unsafe::allocateMemory` → `malloc`/`mmap`（glibc `M_MMAP_THRESHOLD` 分界，128KB 以上直接 mmap，可观测为 `[anon:mmap]` 段）；`Cleaner`/`PhantomReference` 回收滞后 → RSS 不降；`-XX:MaxDirectMemorySize` 超限抛 `OutOfMemoryError: Direct buffer memory`（与内核 OOM 是两条完全不同的路径，务必区分）
- 8.8 NMT 分类 ↔ `/proc/pid/smaps` VMA 的对照表（`Java Heap→` 主匿名大段、`Thread→` 每线程栈段、`Class/Telemetry/GCWoker→` 小块、`Code→` CodeCache、`Internal/Standard→` glibc arena/mmap chunk、`Other/Symbol→`、`GC→`、`Arena Cell`）；`jcmd VM.native_memory baseline` + `summary.diff detail` 的实际输出解读；NMT 只记 JVM `os::` 分配，**glibc malloc 与 JIT 外部库不进 NMT**（12.5 案例根源）
- 8.9 闭环图：一张横跨"JVM 区域 → 分配器选择 → 系统调用 → 内核结构 → 可观测指标"的端到端 ASCII 大表图（本章总结图，可作为全文锚点）

### 第 9 章：生命周期中的地址空间迁移与共享（~250 行）

- 9.1 `fork` 后的 COW 账本复制：`dup_mmap` 逐 VMA 复制 `vm_area_struct` + `anon_vma` 挂链 + `copy_page_range` 把 PTE 全标 `read-only + soft-dirty`；`wp_page_copy` 触发时的 `page_add_new_anon_rmap`；Java 场景：`Runtime.exec`/`ProcessBuilder`（fork+exec）、`jcmd` attach、`GC 日志 rolling` 的 fork、`cgroup v1 的 fork 计费`、fork 大堆的 **TLB shootdown + 页表复制延迟**（数百 ms）
- 9.2 `execve` 替换：`begin_new_exec` 中 `mmput` 旧 mm → 全量 VMA/页表销毁；`check_binfmt_*`、`binfmt_script`/`binfmt_misc`（Java 单文件 `#!/usr/bin/java --source 11` 的两次 exec）
- 9.3 共享与 `MAP_SHARED`：`shmat/shmget`、`/dev/shm` mmap、`memfd_create`、`shm_open`；JVM `-XX:+UsePerfData`（`/tmp/hsperfdata_<user>/<pid>` file-backed mmap，`jcmd/jstat` 的通信机制，`MAP_SHARED` 生命周期跟随 fd）、`-XX:+PerfDisableSharedMem`（消除 `jstat` 触发的 STW 抖动）；`MapByteBuffer`/`FileChannel.map` 的 `MAP_SHARED` 页与 page cache 的 rmap 关系（`page_cache_pipe_buf_ops` 无关，重点：`delete` 文件不影响已映射 VMA → "空间不释放"的经典生产坑）
- 9.4 `uffd`/CRIU 与 JVM：`userfaultfd` + `UFFDIO_REGISTER(MISSING)` 做进程快照恢复；JVM 因 `GC barrier`、`CodeCache`、`JNI` 状态难以 `CRIU` dump，工程上通常用 `AppCDS`/`CRaC`（JDK 17+，注明 11 不可用）替代
- 9.5 页迁移与 NUMA：`numa_balancing` 的 `task_numa_work`、`migrate_misplaced_page`、`sysctl_numa_balancing_mode`；`cpuset.mems`/`numactl --membind` 与容器 `topologyManager`；`memory hotplug/remove`（`online_kernel`/`offline`）对常驻 JVM 的影响（GUP 长期 pin 页导致 offline 失败，`/proc/pressure/memory`）
- 9.6 `MADV_DONTFORK` 与 `pin` 用户：`ibv_reg_mr`、`vhost`、`io_uring` fixed buffers，对 JVM 的 `JNI` 原生库（Netty/RDMA）提示

### 第 10 章：生命周期终点 - munmap、退出与内存回收（~250 行）

- 10.1 `munmap` → `do_vmi_munmap`：`unmap_vmas`（`zap_page_range` 逐页 `tlb_gather_mmu`）→ `vma_unlink` → `free_pgtables`（自顶向下 `PMD/PUD` 页释放，`pud_free_pmd_page`）→ `tlb_finish_mmu` → `vm_unacct_memory`（Overcommit 归还）→ `remove_vma`（`vm_ops->close`、`fput`）；Maple Tree 时代的 `mt_destroy` 与 `MAPI_STATE`
- 10.2 TLB 一致性：`use_mm`/`mmu_gather` 的批量 `flush_tlb_mm_range`、`IPI` 广播（`mm_cpumask`）、`tlb_flush_one_mm`；为什么 `munmap` 大段比 `madvise` 慢（`TLB shootdown` 与 `IPI` 成本，容器多核实测数据）
- 10.3 进程退出：`do_exit` → `exit_mm`（`mmget_not_zero`/`use_mm`）→ `mmput` → `exit_mmap`（`unmap_vmas` → `free_pgtables` → `tlb_finish_mmu` → 遍历 `remove_vma`）→ `destroy_context` → `mmdrop` → `free_mm`；`mmput_async` 与 `deferred free`（`mm->owner` 退出时避免持锁回收，`exit_task_work`）；`vm_stat_account` 清零、`Committed_AS` 归还、`memcg` 计费清零（RSS 与 `memory.current` 的释放次序）
- 10.4 谁先跑完：`SIGTERM` → JVM `Shutdown 序列`（`Shutdown2` hooks → `DestroyJavaVM` → `Threads::destroy_vm` → `os::detach` 各库 → `_exit`）；`kill -9` 与 OOM Killer（`oom_reaper` 异步 `exit_mmap` 加速，`/proc/pid/oom_score`）；两者对 cgroup 释放延迟、K8s `terminationGracePeriodSeconds` 的不同表现
- 10.5 JVM 内部区域各自的生命周期终点：`Heap`（随 mm 销毁）、`Metaspace`（`Metachunk` 归还给 `VirtualSpaceList` 池而非 `munmap`）、`CodeCache`（`nmethod` flush 只改内部位图，不 `madvise`）、线程栈（`glibc stack cache`）、`Direct Buffer`（`free`→glibc，大块才 `munmap`）—— 一张"JVM 认为已释放 / 内核已释放 / RSS 已下降"三列对齐表（12.3 案例的理论基础）
- 10.6 `exit_mm` 慢的观测与后果：`ps -o state` 的 `D`、`/proc/pid/status` 停在 `zombie`、`cgroup memory.current` 滞后、K8s `Pod Terminating` 卡住；用 `perf trace -e 'syscalls:sys_exit_exit_group'` + `tracepoint:task:*` 定位
- 10.7 特殊情况：`mlock` 页的强制回收、`MADV_DONTFORK`、`coredump`（`format_corefile` 时读 VMA）、`/proc/pid/mem` 与 `ptrace` 读写他人地址空间（`jmap -dump` 的 `Attach` + `process_vm_readv`）

### 第 11 章：可观测性 - 观测一个地址空间的完整生命周期（~300 行）

- 11.1 maps 时间序列采集：`while :; do date +%T.%N; cat /proc/$PID/maps; sleep 1; done > maps.log`，配一个用 `awk` 做相邻两次快照 **VMA 增删/大小差分** 的完整脚本（给出可复制脚本正文与输出示例）；`inotifywait` 不适用（procfs）
- 11.2 `smaps`/`smaps_rollup`：逐字段表（`Rss/PssAnon/PssFile/Uss/Shared_*/Private_*/Swap/THPeligible/VmFlags/LazyFree/AnonHugePages`）；`pmap -x` 的汇总差异；`awk` 脚本按 `Uss` 排序找最大 VMA；`VmFlags` 位速查表（`dd/gd/se/lo/nl/sh/mr/mw/me/ms/mg/nr/hg/nh`）
- 11.3 `status`/`stat`/`statm`/`io`：`VmPeak/VmSize/VmLck/VmPin/VmHWM/VmRSS/RssAnon/RssFile/RssShmem/VmData/VmStk/VmExe/VmLib/VmPTE/VmPMD/VmSwap/Threads` 逐项含义与单位换算（`statm` 以页为单位）；`min_flt/maj_flt` 位置；`/proc/vmstat` 关键计数（`pgpgin/pgpgout/pgfault/pgmajfault/compact_stall/thp_split_*`）
- 11.4 `pagemap`/`page-types`：64 位 entry 解码（bit63 present / bit62 swapped / bit61 file / bit55 soft-dirty / bits 0-54 PFN）；给出 Python 3 逐页统计脚本（约 20 行，读 `/proc/pid/pagemap` + `/proc/kpagecount`/`kpageflags`），输出"某 VMA 内已驻留页比例"（这就是 commit 与 resident 的实测差）
- 11.5 `perf`：`perf stat -e page-faults,minor-faults,major-faults -p PID`；`perf record -e exceptions:page_fault_user -g` + `perf script`；`perf trace -e mmap,munmap,brk,mprotect,madvise,mremap -p PID`；`/proc/sys/kernel/perf_event_paranoid`
- 11.6 eBPF/bpftrace 实操（给可直接运行的脚本）：
  - `tracepoint:syscalls:sys_enter_mmap{...}` 统计 `prot/flags/offset` 分布，识别 `PROT_NONE` 预留
  - `kprobe:do_mmap` / `kprobe:brk` / `kretprobe:vm_mmap`
  - `kprobe:handle_mm_fault` 按 `vmf->vma->vm_start` 直方图（`@faults[pid]=hist(...)`），定位是哪个 VMA 在缺页
  - `kprobe:os::Linux::commit_memory` 不可用（用户态符号）→ 用 `uprobe:/usr/lib/jvm/.../libjvm.so:os::Linux::commit_memory`（C++ mangled name，注意 `--unsafe-probe`）
  - `kprobe:exit_mm` / `kprobe:exit_mmap` 计时，量化退出耗时
  - `bpf_iter_task_vma`（`procmem` 工具）遍历 VMA
  - `mm` 类 `bcc` 工具：`offwaketime`/`biostacks` 不适用，重点 `memleak.py`（分配器层）+ `oomkill`（`memcg` 层），并声明与本文层次的区别
- 11.7 ftrace 事件：`events/msync`、`events/kmem`、`events/vmscan`（`mm_vmscan_direct_reclaim_begin`）、`events/oom`、`/sys/kernel/debug/tracing` 打开 `mmap` 相关 tracepoint 的命令序列
- 11.8 JVM 侧配套：`jcmd <pid> VM.native_memory summary.diff`、`jcmd <pid> VM.info`、`-Xlog:mm+stats`、`jcmd <pid> Thread.print | grep -c 'java.lang.Thread'` × `-Xss` 估算栈地址空间、`jstack` 与 `Thread` VMA 数对账、`jcmd GC.heap_info` 的 `regions`/`committed`、`-XX:NativeMemoryTracking=trace` 的可用性说明
- 11.9 **端到端时序观测实验**（本章压轴，可复现）：一个 200 行 `demo.sh` + `App.java` 的完整实验脚本，按 `T0 execve / T1 reserve / T2 PreTouch / T3 业务分配 / T4 周期性 GC uncommit / T5 munmap / T6 exit` 六个时点打印 `VmSize/VmRSS/VmData/RssAnon/map_count/pgfault`，附一张真实采集的表格（每时点一行的六列数值），并逐列解释每个数字跳变对应的内核动作
- 11.10 观测指标进入监控：Prometheus `process_vm_*`（`/proc/<pid>/status` exporter）、cAdvisor `container_memory_rss/spec`、K8s `working_set = usage - inactive_file`、`node_memory_AnonPages`；告警阈值建议（`VmData` 增速、`map_count` 绝对值、`pgmajfault` 速率）

### 第 12 章：企业故障案例分析（6 个，~420 行）

严格套用"现象 / 假设 / 证据采集 / 根因 / 修复 / 验证"模板，每个案例的证据必须是本章前面讲过的结构（maps 差分、smaps、pagemap、bpftrace、NMT）。案例只从**地址空间生命周期**角度切入，避免与《系统内存分配应用分析》第 7 章、《JVM 配置指南》第 10 章重复。

- 12.1 案例 1：`VmSize 45GB` 触发监控告警被误判为内存泄漏 —— 实为 `-Xmx16g` 的 `PROT_NONE` 预留 + 640 线程栈 + Metaspace 预留；修复：监控口径改为 `VmRSS`/`PSS` 与 `working_set`，为 VSZ 单独设阈值
- 12.2 案例 2：`Cannot allocate memory` / `Could not reserve enough space for object heap` —— `vm.overcommit_memory=2` + `CommitRatio=50` 与 `vm.max_map_count=65530` 两类不同失败：前者在 `__vm_enough_memory`（预留即失败），后者在 `mmap` 返回 `ENOMEM`（线程/Netty 段数超限）；证据：`strace` 的 mmap 返回值 + `/proc/sys/vm/overcommit_memory`；修复：`overcommit_memory=0`、`max_map_count=262144`、`-Xss512k`、`MALLOC_ARENA_MAX=2`
- 12.3 案例 3：GC 后 `RSS` 不降（`-Xmx16g -Xms16g` + G1）—— 三层原因：(a) JVM 未 uncommit（G1 无 `G1PeriodicGCInterval`）、(b) uncommit 走 `MADV_DONTNEED` 但 THP 拆分延迟、(c) glibc arena 不还（`malloc_trim`）。给出 `pmap -x` 前后差分 + `RssAnon` 曲线 + `MADV_PAGEOUT` 验证；修复：`G1PeriodicGCInterval=300000`、`SoftMaxHeapSize`、`MALLOC_TRIM_THRESHOLD_`、容器 limits 收紧
- 12.4 案例 4：Metaspace 反复 commit/decommit 导致 `Sys` 时间占比 18% —— 类加载器抖动（Groovy/动态代理）+ `MinMetaspaceFreeRatio` 过小，`Uncommitter` 每轮释放 chunk 又被 `mprotect` 重新 commit，页表反复建立/销毁；证据：`bpftrace kprobe:handle_mm_fault` 直方图集中在 `[anon:metaspace]` VMA + NMT `Uncommitted` 抖动；修复：`MetaspaceSize=256m`、`MinMetaspaceFreeRatio=70`、`MaxMetaspaceSize` 上限收紧、缓存动态类
- 12.5 案例 5：`Internal/Standard` 持续 mmap 且退出慢 —— Netty `PoolArena` + `DirectByteBuffer` Cleaner 滞后，`Unsafe.allocateMemory` 大块走 glibc mmap 阈值（`M_MMAP_THRESHOLD` 动态上调），RSS 随流量阶梯上涨；`exit_mm` 耗时 40s（`pagemap` 显示 38GB 驻留页逐个 `zap`）导致 K8s `Terminating` 超 `gracePeriod` 被 `SIGKILL`；修复：`MaxDirectMemorySize`、`io.netty.maxDirectMemory=0`、jemalloc `dirty_decay_ms=1000`、`terminationGracePeriodSeconds` 调大 + 预缩容
- 12.6 案例 6：启动 8GB `-Xms=-Xmx` + `AlwaysPreTouch` 冷启动 6 分钟 —— 缺页串行 + `defrag=always` 导致 THP 分配同步回收/compaction；证据：`/proc/vmstat` `compact_stall`、`pgscan_direct` 与 `thp_split_page` 同步增长、`perf record exceptions:page_fault_user`；修复：THP 改 `madvise`、`G1PreTouchAttr=first-touch/mpol`(11 部分不支持，注明)、并行 pre-touch（`-XX:ParallelGCThreads`）、分批预热流量、K8s `startupProbe` 放宽

### 第 13 章：调优方法论 - 让 JVM 与内核的地址空间策略对齐（~260 行）

- 13.1 预留/提交策略对齐决策树：`-Xms=-Xmx` vs `-Xms` 小 + `AlwaysPreTouch` vs 小 `-Xms` + 允许 uncommit 三种模式的"启动时间 / 尾延迟 / RSS 可控性 / OOM 风险"四维对比表；对应内核参数 `overcommit_memory`、`max_map_count`、`mmap_min_addr`
- 13.2 缺页成本控制：`MAP_POPULATE`/`MADV_WILLNEED`/`mlock`/`pre-touch` 的选择矩阵；`fault_around_bytes` 调大对大堆的意义；`startupProbe` 与流量预热
- 13.3 大页决策表：THP `always/madvise/never` × `defrag` × JVM `UseLargePages`/`UseLargePagesInMetaspace`/显式 hugetlb 的九宫格，含容器 `hugepages` limit、`nr_hugepages` 启动前分配与 NUMA 均分（`nr_overcommit_hugepages`）
- 13.4 归还与延迟的取舍：`MinHeapFreeRatio/MaxHeapFreeRatio`（Parallel）、`G1PeriodicGCInterval`、`SoftMaxHeapSize`、`Metaspace` `Uncommitter`、glibc `MALLOC_TRIM`、jemalloc `dirty/muzzy_decay_ms`、`MADV_FREE` vs `DONTNEED` 的归还速度/成本对比；给出一条"归还越快，二次缺页越贵"的权衡曲线说明（配 ASCII 折线示意）
- 13.5 生命周期各阶段的可观测 SLO 基线表：`VmData 增速`、`map_count`、`pgmajfault/s`、`PSS-spec 差值`、`exit_mmap 耗时`、`THPeligible 比例`，建议阈值与告警分级
- 13.6 容量预算公式（用少量数学表达式，注意 `$` 单行唯一）：`进程 RSS ≈ Heap_resident + Σ线程栈_touched + Metaspace_committed + CodeCache + DirectBuffer + glibc_arena + lib mapping + PageTables + SwapOut`；`进程 VSZ ≈ Heap_reserved + Σ(线程栈 + guard) + ReservedCodeCache + MaxMetaspace 预留 + …`；容器 `limits` = 预算 + 20% 余量的推导示例
- 13.7 JVM 参数 ↔ 内核参数 ↔ cgroup/K8s 字段三方对照大表（约 25 行，本文最重要的速查表）
- 13.8 上线检查清单（15 条，可直接放进变更单）

### 第 14 章：与其他运行时的横向对比（~220 行）

- 14.1 五个维度定义对比框架：预留时机 / 提交粒度 / 归还粒度与手段 / RSS 语义 / 可观测接口
- 14.2 Go runtime：`sysAlloc`（`MAP_ANON|MAP_PRIVATE`）→ arena（64 位默认 64MB，`heapAddr` 区一次性 `sysMap(1<<33)` 预留）、`HeapSys/HeapIdle/HeapInuse/HeapReleased`（`runtime.ReadMemStats`）、`MADV_FREE` 归还（`scavenger`，`GOGC`/`GOMEMLIMIT`+`GOMAXPROCS` 的软限）、`mheap_.arenas` 两级页表式索引；`cgroups memory limit` 下 `GOMEMLIMIT` 的实际价值
- 14.3 V8/Node.js：`VirtualMemory`/`PageAllocator`（`mmap PROT_NONE` 预留 + `SetPermissions` commit，与 HotSpot 同构）、`--max-old-space-size`、`ArrayBuffer` 走 `malloc`、`v8.setHeapSizeWithExternalMemory`、`--expose-gc` + RSS 不降
- 14.4 .NET CLR：`VirtualAlloc(MEM_RESERVE/MEM_COMMIT)` 在 Linux 上经 `pal` 映射到 `mmap/mprotect`、`GCHeap` 段与 `GCSegmentAllocate`、`.NET 6/8` 的 `NativeMemory` 与 `GCRetentionPolicy`
- 14.5 CPython：`pymalloc arena(256KB)/pool(4KB)/block`，无 reserve/commit 概念，直接 `malloc` → glibc → `brk/mmap`；`tracemalloc` 与地址空间无对应
- 14.6 jemalloc/tcmalloc/mimalloc 的地址空间视角：`extent`/`arena` 的 `MAP_NORESERVE` 预留、`dirty/muzzy/retained` 三态（`retain` 是 jemalloc 特有：`unmap` 只降 commit 不释放 VA，避免 `mmap` 碎片化）、`MADV_DONTNEED/FREE`、`thp` 自适应；`mimalloc` 的 `segment`（64MB，保留不释放）
- 14.7 一张六运行时总对比表 + "为什么 Java 的 VSZ 天生就高、Go 的 RSS 下降最积极、Node 的堆外最难归因"三条结论
- 14.8 Rust（`std` 无运行时堆管理，走 `malloc`/自定义 `GlobalAlloc`）与 `mmap` 手写生命周期，呼应《Rust 开发 OS 内核设计思路》

### 第 15 章：总结与学习路径（~180 行）

- 15.1 全文压轴图：一张端到端 ASCII 生命周期大图（`execve → bprm_mm_init → load_elf_binary → set_brk → java mmap(PROT_NONE) reserve → mprotect commit → handle_mm_fault → alloc_pages → 页表 → RSS↑ → G1 uncommit → madvise(DONTNEED) → zap_page_range → RSS↓ → munmap → free_pgtables → exit_mm → mmdrop`），每个节点标注对应章节号
- 15.2 三条不变式（心智模型收束）：(1) 地址空间与物理页是两本账，`PROT_NONE`/`MADV_DONTNEED` 只动其中一本；(2) RSS 下降是内核行为，不是应用"释放"的结果；(3) 每一次 uncommit 都可能在将来重付一次缺页
- 15.3 常见误区清单（12 条，每条一句"你以为 / 实际"），例如：VSZ=泄漏、`-Xmx`=进程内存、`MADV_DONTNEED`=立刻归还物理设备（是清页表，物理页回 buddy，但 cgroup/计费/THP 拆分有延迟）、`munmap` 比 `madvise` 便宜、GC 日志能解释 RSS、`jmap` 显示的堆 = 内核看到的、NMT 覆盖进程全部分配
- 15.4 进阶方向：内核源码阅读路线（`mm/mmap.c` → `mm/memory.c` → `fs/exec.c` → `kernel/fork.c` → `mm/madvise.c` → `mm/rmap.c`）、HotSpot 源码路线（`os_linux.cpp` → `virtualSpaceNode.cpp` → `memAllocator.cpp` → `g1CollectedHeap.cpp` → `metaspace/`）、`membarrier`/`userfaultfd`/`DAMON`(5.15)、`MADV_POPULATE`/`per-VMA locks`/`MAPLE_TREE` 的现代演进
- 15.5 参考资源：《Understanding Linux Memory Management》、Linux man-pages（`mmap(2)`/`madvise(2)`/`proc(5)`/`pagemap(2)`）、LWN 关于 maple tree 与 per-VMA lock 的文章、OpenJDK 源码与 JEP（JEP 351 Reduce Native Memory Usage、JEP 312 Thread Local Handshakes）、cgroup v2 文档、K8s `working_set` 定义
- 15.6 系列阅读顺序建议（四篇文章的递进关系图）

## 关键写作约束（Assumptions & Decisions）

1. **不改动除目标文件外的任何文件**；不改 `_config.yml`、不装插件、不改主题、不 commit、不 `hexo deploy`（用户未要求）。
2. **禁止 mermaid 代码块**（无渲染插件），全部图示用 ```text ASCII 框图；ASCII 图每行宽度控制在 72 列内，边框字符必须逐行对齐（成稿后逐图肉眼检查 + `awk 'length>72'` 复核）。
3. **`$` 使用纪律**：正文只在必要处使用行内公式，同一行不得出现两个裸 `$`；`bash` 代码块内避免同一行多处 `$`（`awk '{print $2}'` 单独成行），防止 `scripts/protect-math.js` 误配对导致还原异常。
4. **版本口径必须准确**：涉及具体内核版本能力（Maple Tree 6.1、per-VMA locks 6.5、`MADV_POPULATE` 5.14、`process_madvise` 5.10、`MADV_PAGEOUT` 5.4、`MADV_FREE` 4.5、`MAP_FIXED_NOREPLACE` 4.17、`MREMAP_DONTUNMAP` 5.7）与 JDK 版本能力（`G1PeriodicGCInterval` JDK11u、`MetaspaceReclaimPolicy` JDK11u4+/13、`ReduceProcessMemory` JDK14、`Thread.print`/`GC.class_stats` 需 `-XX:+UnlockDiagnosticVMOptions`、JEP 351）都要标注，不确定的一律写"需以具体版本验证"而不是猜测。
5. **与姊妹篇去重**：分配器内部（chunk/arena/tcache 结构）只在一句内引用《系统内存分配应用分析》，GC 算法与参数调优细节引用《Java11虚拟机系统配置指南》，基础页表科普引用《系统内核基础结构分析》；本文独有的内容是 VMA/mm_struct/系统调用路径/缺页路径/退出回收/生命周期观测时序。
6. **命令与输出示例必须真实可信**：所有 `bash` 示例基于 Linux 5.10+/OpenJDK 11.0.20、x86-64、cgroup v2 环境书写；输出片段为典型值，数值自洽（例如 8GB 堆的 PTE 元数据 ≈ 8GB/512 = 16MB；8GB/4KB = 2,097,152 次缺页）。
7. **每章末尾固定 `**本章要点：**`**，章间用单独一行 `---`；第 1 章开篇加一行 `>` 导语（对齐内核基础篇风格）。
8. **规模下限**：正文 ≥ 3000 行（不含 front matter），预计 3200-3600 行。宁可分 8 批写入，不压缩章节内容。

## 分批写入实施步骤（执行阶段）

文件为空，采用"首批 Write + 后续 SearchReplace 锚定追加"，每批追加前必须先确认上一批的末尾唯一文本（各批末尾都以该章"本章要点"最后一条 bullet + 一行 `---` 结尾，作为唯一锚点）。

| 批次 | 内容 | 目标行数 |
|---|---|---|
| P1 | front matter + 导语 + 第 1-2 章 | ~560 |
| P2 | 第 3-4 章 | ~640 |
| P3 | 第 5-6 章 | ~590 |
| P4 | 第 7-8 章 | ~670 |
| P5 | 第 9-10 章 | ~510 |
| P6 | 第 11 章 | ~310 |
| P7 | 第 12 章（6 个案例） | ~430 |
| P8 | 第 13-15 章 + 收尾 | ~660 |

每批完成后立刻跑一次 `Measure-Object -Line` 确认累计行数；全部批次完成后进入 Verification。

## Verification

1. `Get-Content` 行数确认 ≥ 3000；`Grep '^# 第 \d+ 章'` 必须命中 15 条且编号连续 1..15。
2. 代码围栏配平：`Grep '^```'` 的出现次数必须为偶数（ASCII 图 + bash + c + cpp + yaml 全部计入）。
3. 结构检查：每章末尾存在 `**本章要点：**`；章间 `---` 分隔符数量 = 14。
4. Front matter 解析：首行为 `---`，第 5 行（`---` 结束）后必须为空行 + `#` 或 `>` 起头。
5. 渲染验证：`npm run build`（`hexo generate`）零错误；确认控制台无 `[protect] … tokens=` 异常增长、无 `WARN`/`FATAL`；生成的 `docs/2026/10/01/…/index.html` 存在（`Glob docs/2026/10/**`）。
6. 抽样渲染检查：在生成的 HTML 中确认 ASCII 图位于 `<pre><code class="language-text">` 内未被折叠、bash 块有 `hljs` 类、表格渲染为 `<table>`。
7. 本地预览（可选，用户如需要）：`npm run server` + `http://localhost:4000` 打开本文，检查 TOC（indigo 主题右侧目录）能列出 15 个一级章节。
8. 一致性终检：全文对同一数值的引用自洽（8GB 堆缺页数、页表元数据、线程栈总量），无与姊妹篇冲突的事实表述。
