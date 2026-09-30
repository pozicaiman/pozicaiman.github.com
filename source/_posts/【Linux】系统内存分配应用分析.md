---
title: Linux 系统内存分配应用分析：从 malloc 到 OOM 的完整链路
date: 2026-09-30 16:00:00
categories: [操作系统]
tags: [Linux, 内存, 性能优化, JVM, 容器, Kubernetes]
---

# 第 1 章：引言 - 内存问题的本质

## 1.1 内存问题为什么难以定位

在生产环境中，内存问题是最棘手的一类故障。与 CPU 或网络问题不同，内存问题往往具有以下特征：

> **延迟性**：内存泄漏可能在运行数天甚至数周后才触发 OOM，难以与代码变更关联。
>
> **隐蔽性**：进程的 RSS（Resident Set Size）并不等于"真实使用量"，共享库、mmap 映射、page cache 都会使 `top` 看到的数字产生误导。
>
> **链路复杂性**：一次 `malloc(1024)` 调用，可能经历 glibc 分配器 → 内核 page fault → NUMA 节点选择 → cgroup 计费 → 最终物理页映射，任何一个环节都可能成为问题根源。

一个常见的误区是将 `top` 中的 `RES` 列直接等同于进程的"内存使用量"。实际上：

```text
┌─────────────────────────────────────────────────────┐
│              进程虚拟地址空间 (VMA)                    │
├─────────────────────────────────────────────────────┤
│  代码段 (.text)        ← 共享，多个进程复用同一物理页    │
│  数据段 (.data/.bss)   ← 私有，按需分配                 │
│  堆 (heap)             ← brk 扩展，glibc 管理          │
│  匿名 mmap             ← 大块分配、线程栈              │
│  文件映射 (mmap)       ← 共享库、page cache            │
│  栈 (stack)            ← 线程私有，自动增长             │
└─────────────────────────────────────────────────────┘
```

`RSS` 统计的是驻留在物理内存中的页，但它包含共享库的共享部分。两个进程加载同一个 `libc.so`，同一物理页会被两个进程的 RSS 都计入，导致简单相加后数值远超实际物理内存使用量。这就是为什么我们需要 `PSS`（Proportional Set Size）来做更精确的归因。

## 1.2 内存分配的完整链路：从应用到硬件

一次完整的内存分配涉及多个层次，每个层次都有独立的管理策略和优化机制：

```text
┌─────────────────────────────────────────────────────────────────┐
│                        应用层                                    │
│   Java: new Object()                                            │
│   Go:   make([]byte, 1024)                                      │
│   C:    malloc(1024)                                            │
│   Python: [1, 2, 3]                                             │
├─────────────────────────────────────────────────────────────────┤
│                     语言运行时                                    │
│   JVM GC Heap │ Go mcache/mcentral/mheap │ Python pymalloc      │
├─────────────────────────────────────────────────────────────────┤
│                    C 库分配器                                     │
│   glibc ptmalloc2 │ jemalloc │ tcmalloc                         │
├─────────────────────────────────────────────────────────────────┤
│                     系统调用层                                    │
│   brk() / sbrk() │ mmap() / munmap()                           │
├─────────────────────────────────────────────────────────────────┤
│                    内核内存管理                                   │
│   伙伴系统 (Buddy) → slab 分配器 → 页表管理                       │
├─────────────────────────────────────────────────────────────────┤
│                   硬件 / MMU                                     │
│   物理内存 │ TLB │ NUMA 节点 │ 内存控制器                         │
└─────────────────────────────────────────────────────────────────┘
```

## 1.3 本文的目标与读者

本文面向**后端开发者、SRE、性能工程师**，目标是：

1. **理解内存分配的完整链路**，从 `malloc` 到物理页映射的每一步
2. **掌握各语言运行时的内存模型**，知道 JVM / Go / Python / Node.js 各自在做什么
3. **具备内核级内存分析能力**，能阅读 `/proc`、使用 eBPF、理解 cgroup 计费逻辑
4. **建立系统化的排查方法论**，通过真实案例展示从现象到根因的完整推理链

**本章要点：**

- **内存问题的三大特征**：延迟性、隐蔽性、链路复杂性
- **RSS 不等于真实使用量**，需要 PSS、USS 等更精确的指标
- **内存分配涉及六个层次**：应用 → 运行时 → C 库 → 系统调用 → 内核 → 硬件

---

# 第 2 章：用户态内存分配 - malloc 的真实行为

## 2.1 glibc malloc：ptmalloc2 架构

glibc 使用的内存分配器是 **ptmalloc2**（基于 Doug Lea 的 dlmalloc 演进而来）。理解 ptmalloc2 的内部结构，是分析内存问题的基础。

### 2.1.1 chunk：最小管理单元

ptmalloc2 管理的最小单位是 **chunk**。每个 chunk 包含一个头部和用户数据区：

```text
chunk 结构（64 位系统，最小 32 字节）：

┌──────────────────────────────────────────────┐
│              prev_size (8 bytes)              │  ← 前一个 chunk 空闲时记录其大小
├──────────────────────────────────────────────┤
│              size (8 bytes)                   │  ← 当前 chunk 大小 + 标志位
├──────────────────────────────────────────────┤
│              fd (8 bytes)                     │  ← 空闲时：forward pointer
├──────────────────────────────────────────────┤
│              bk (8 bytes)                     │  ← 空闲时：backward pointer
├──────────────────────────────────────────────┤
│              ... 用户数据 ...                  │  ← malloc 返回的指针指向这里
└──────────────────────────────────────────────┘
```

`size` 字段的低 3 位用作标志位：

- **bit 0 (PREV_INUSE)**：前一个 chunk 是否正在使用
- **bit 1 (IS_MMAPPED)**：该 chunk 是否通过 mmap 分配
- **bit 2 (NON_MAIN_ARENA)**：该 chunk 是否属于非主 arena

```c
/* glibc malloc 源码中的关键宏定义 */
/* chunk_at_offset(p, s) 从偏移量获取 chunk */
/* size 字段对齐到 2*SIZE_SZ（16 字节对齐） */

#define SIZE_SZ (sizeof(INTERNAL_SIZE_T))  /* 8 bytes on 64-bit */
#define MALLOC_ALIGNMENT (2 * SIZE_SZ)     /* 16 bytes */
#define MALLOC_ALIGN_MASK (MALLOC_ALIGNMENT - 1)

/* 从 size 字段提取实际大小（去掉标志位） */
#define chunksize(p) (chunksize_nomask(p) & ~(SIZE_BITS))

/* 判断前一个 chunk 是否在使用 */
#define prev_inuse(p) ((p)->size & PREV_INUSE)

/* 判断是否 mmap 分配 */
#define chunk_is_mmapped(p) ((p)->size & IS_MMAPPED)
```

### 2.1.2 bins 链表：空闲 chunk 的组织

空闲 chunk 通过 **bins** 链表组织。ptmalloc2 使用三种 bins：

| Bin 类型 | 范围 | 组织方式 | 用途 |
|---------|------|---------|------|
| **fastbins** | 32~128 字节（默认） | 单链表，LIFO，不合并 | 小块快速分配 |
| **small bins** | 128~512 字节 | 双链表，FIFO，按大小分类（62 个） | 小块精确匹配 |
| **large bins** | >512 字节 | 双链表，按大小排序，近似匹配 | 大块分配 |

```text
fastbins（单链表，每种大小一个）：
  fastbin[0] → chunk_32B → chunk_32B → NULL
  fastbin[1] → chunk_48B → NULL
  fastbin[2] → chunk_64B → NULL
  ...

small bins（双链表，62 个，每个大小不同）：
  smallbin[2] ↔ chunk_32B ↔ chunk_32B ↔ smallbin[2]
  smallbin[3] ↔ chunk_48B ↔ smallbin[3]
  ...

unsorted bin（双链表，1 个）：
  unsorted_bin ↔ chunk_A ↔ chunk_B ↔ unsorted_bin
  ← 回收的 chunk 先放入这里，下次分配时分类
```

malloc 的查找顺序：

```text
malloc(size)
    │
    ├─ size <= fastbin_max ? ──→ 从 fastbins[idx] 取 ──→ 直接返回
    │
    ├─ 尝试从 small bins[idx] 取 ──→ 找到则返回
    │
    ├─ 遍历 unsorted bin ──→ 精确匹配则返回
    │                          否则按大小分入 small/large bins
    │
    ├─ 从 small bins 中 best-fit 查找
    │
    ├─ 从 large bins 中 best-fit 查找
    │
    ├─ 以上都失败 → 使用 top chunk 扩展
    │
    └─ top chunk 也不够 → 调用 sbrk() / mmap() 向内核申请
```

## 2.2 arena 机制：多线程内存分配的优化

多线程程序如果所有线程共享同一个分配锁，会导致严重的锁竞争。ptmalloc2 的解决方案是 **arena 机制**。

### 2.2.1 arena 的创建规则

```text
arena 创建策略：
┌─────────────────────────────────────────────────┐
│  主 arena：进程启动时自动创建                      │
│  额外 arena：动态创建，上限 = 8 × CPU 核数        │
│                                                   │
│  线程绑定规则：                                    │
│  1. 线程首先尝试绑定已有的、未被占用的 arena         │
│  2. 如果没有空闲 arena 且未达上限，创建新 arena     │
│  3. 如果已达上限，与其他线程共享 arena（轮询选择）   │
└─────────────────────────────────────────────────┘
```

```text
多线程 arena 分配示意：

Thread 1 ──→ ┌──────────┐
              │ Arena 0  │ (主 arena，使用 brk 管理 heap)
Thread 2 ──→ │  heap 区  │
              └──────────┘

Thread 3 ──→ ┌──────────┐
              │ Arena 1  │ (额外 arena，使用 mmap 创建独立 heap)
Thread 4 ──→ │  mmap 区  │
              └──────────┘

Thread 5 ──→ ┌──────────┐
              │ Arena 2  │
              └──────────┘
```

> **关键点**：主 arena 使用 `brk()` 管理堆区，而额外 arena 使用 `mmap()` 创建独立的 heap segment。这意味着不同 arena 的内存是相互独立的，无法跨 arena 合并碎片。

### 2.2.2 查看 arena 信息

```bash
# 查看进程的 arena 数量（需要 glibc 调试信息）
$ gdb -p <pid> -batch -ex 'call (void)malloc_stats()' 2>&1

# 或者通过环境变量控制
$ export MALLOC_ARENA_MAX=4  # 限制最多 4 个 arena

# 查看 glibc 版本支持的 arena 上限
$ ldd --version
ldd (GNU libc) 2.31
```

## 2.3 mmap vs brk：大块内存与小块内存的分界

glibc 使用一个阈值来决定用 `brk()` 还是 `mmap()` 分配内存：

```c
/* glibc 默认阈值（可通过 mallopt 调整） */
#define DEFAULT_MMAP_THRESHOLD_MIN (128 * 1024)  /* 128 KB */
#define DEFAULT_MMAP_THRESHOLD_MAX (32 * 1024 * 1024) /* 32 MB */

/* 动态调整：glibc 会根据 free 的大小自适应调整阈值 */
/* 默认初始值：128 KB（可通过 M_MMAP_THRESHOLD 设置） */
```

| 特性 | brk() / sbrk() | mmap() / munmap() |
|------|----------------|-------------------|
| **分配粒度** | 连续扩展 heap 顶端 | 独立的内存区域 |
| **释放方式** | 只能从顶端释放 | 可以独立 munmap |
| **碎片影响** | 顶端未释放会阻塞整段 | 独立释放，不受其他块影响 |
| **适用场景** | 小块、频繁分配 | 大块、长时间持有 |
| **系统调用开销** | 较低 | 较高（涉及 VMA 管理） |

```text
brk 的碎片问题：

heap 低地址                                              heap 高地址 (brk)
  ┌────┬────┬────┬────┬────┬────┬────┬────┐
  │ A  │ B  │ C  │ D  │ E  │ F  │ G  │ H  │  ← 初始状态
  └────┴────┴────┴────┴────┴────┴────┴────┘

free(B); free(D); free(F); free(H); 之后：

  ┌────│空闲│────│空闲│────│空闲│────│空闲│
  │ A  │    │ C  │    │ E  │    │ G  │    │  ← 无法缩减 brk！
  └────┘    └────┘    └────┘    └────┘    │    因为 E 和 G 仍然存活
                                           │
                                      brk 无法收缩 ← 内存泄漏的假象
```

## 2.4 内存碎片化：glibc 的阿喀琉斯之踵

glibc ptmalloc2 的碎片化问题是生产环境中 RSS 虚高的最常见原因之一。

### 2.4.1 碎片化的类型

```text
┌──────────────────────────────────────────────────┐
│              内存碎片化类型                         │
├──────────────┬───────────────────────────────────┤
│  内部碎片     │ chunk 实际大小 > 用户请求大小        │
│  (Internal)  │ 例如 malloc(100) 分配 112 字节      │
│              │ 多出的 12 字节被浪费                  │
├──────────────┼───────────────────────────────────┤
│  外部碎片     │ 空闲 chunk 足够大，但不连续          │
│  (External)  │ 例如需要 1MB 但空闲的是 10 个 100KB  │
│              │ 不连续的 chunk                       │
├──────────────┼───────────────────────────────────┤
│  arena 碎片  │ 不同 arena 之间无法合并空闲内存      │
│              │ Arena 0 有 50MB 空闲                │
│              │ Arena 1 需要 60MB → 向内核新申请     │
└──────────────┴───────────────────────────────────┘
```

### 2.4.2 碎片化的经典场景

**场景一：多线程交替分配释放**

```c
/* 线程 A (Arena 0) */
void* ptrs_a[1000];
for (int i = 0; i < 1000; i++)
    ptrs_a[i] = malloc(4096);  /* 4KB 分配 */

/* 线程 B (Arena 1) */
void* ptrs_b[1000];
for (int i = 0; i < 1000; i++)
    ptrs_b[i] = malloc(4096);

/* 释放间隔分配的块 */
for (int i = 0; i < 1000; i += 2)
    free(ptrs_a[i]);
/* 此时 Arena 0 有大量空闲，但 Arena 1 的线程无法使用 */
```

**场景二：长生命周期对象阻塞 brk 回收**

```c
/* 一次分配大量临时数据 */
for (int i = 0; i < 10000; i++) {
    temp[i] = malloc(256);
}

/* 同时有一个长期存在的小对象 */
long_lived = malloc(32);  /* 分配在 heap 低地址 */

/* 释放临时数据 */
for (int i = 0; i < 10000; i++) {
    free(temp[i]);
}
/* 但是 long_lived 阻止了 brk 收缩 */
/* 所有临时数据占用的空间都无法归还给内核 */
```

## 2.5 malloc_trim 与内存归还

glibc 提供了主动回收内存的机制，但很多开发者并不知道：

```c
#include <malloc.h>

/* 手动触发内存归还 */
/* 返回 1 表示成功释放了内存，0 表示无可释放的内存 */
int malloc_trim(size_t pad);

/* 设置自动 trim 阈值 */
mallopt(M_TRIM_THRESHOLD, 128 * 1024);   /* top chunk 超过此值时自动 trim */
mallopt(M_TOP_PAD, 0);                     /* trim 时保留的余量 */

/* 设置 mmap 阈值 */
mallopt(M_MMAP_THRESHOLD, 128 * 1024);    /* 超过此大小使用 mmap */

/* 禁用 mmap（强制使用 brk）——通常不推荐 */
mallopt(M_MMAP_MAX, 0);
```

```bash
# 通过 gdb 在运行中的进程触发 trim
$ gdb -p <pid> -batch -ex 'call (int)malloc_trim(0)'

# 设置环境变量控制 glibc 行为
$ export MALLOC_TRIM_THRESHOLD_=131072
$ export MALLOC_TOP_PAD_=0
$ export MALLOC_MMAP_THRESHOLD_=131072
```

> **实践建议**：在长生命周期服务中，可以定期调用 `malloc_trim(0)`（例如每 30 秒一次），将空闲内存归还给内核。这对于使用 glibc 分配器的 C/C++ 服务、JVM 的 Native Memory 部分特别有效。

**本章要点：**

- **ptmalloc2 使用 chunk 作为最小管理单元**，包含 size/flags 和 fd/bk 指针
- **fastbins → small bins → unsorted bin → large bins** 构成分配的四级查找体系
- **arena 机制避免多线程锁竞争**，但跨 arena 无法合并空闲内存，加剧碎片化
- **brk 适用于小块分配**，但有"顶端阻塞"问题；mmap 适用于大块分配，可独立释放
- **malloc_trim(0) 是主动回收 RSS 的利器**，但需要在合适时机调用

---

# 第 3 章：语言运行时的内存模型

## 3.1 JVM 内存模型：Heap + Native Memory + Metaspace

JVM 的内存远不止 `-Xmx` 指定的 Heap 大小。一个 JVM 进程的完整内存构成如下：

```text
JVM 进程 RSS 内存分解
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  ┌─────────────────────────┐  ← -Xmx 控制上限                │
│  │       Java Heap          │                                 │
│  │  ┌─────┬─────┬─────┐    │  Young Gen (Eden + S0 + S1)     │
│  │  │ Eden│  S0 │  S1 │    │                                 │
│  │  ├─────┴─────┴─────┤    │                                 │
│  │  │    Old Gen       │    │                                 │
│  │  └──────────────────┘    │                                 │
│  ├─────────────────────────┤                                 │
│  │     Metaspace            │  ← -XX:MaxMetaspaceSize         │
│  │  (类元数据、方法信息)      │  存储在 Native Memory 中       │
│  ├─────────────────────────┤                                 │
│  │   Thread Stacks          │  ← -Xss × 线程数               │
│  │   (每个线程 512KB~1MB)    │                                 │
│  ├─────────────────────────┤                                 │
│  │   Code Cache             │  ← -XX:ReservedCodeCacheSize    │
│  │   (JIT 编译后的机器码)    │                                 │
│  ├─────────────────────────┤                                 │
│  │   Direct ByteBuffer      │  ← -XX:MaxDirectMemorySize      │
│  │   (堆外直接内存)          │                                 │
│  ├─────────────────────────┤                                 │
│  │   GC 数据结构             │  Card Table, Remembered Set     │
│  │   JNI 引用               │                                 │
│  │   符号表 / 字符串表       │                                 │
│  ├─────────────────────────┤                                 │
│  │   Native Memory (malloc) │  libjvm.so 内部 malloc          │
│  │   (glibc arena 分配)     │  ← 这部分常被忽略！             │
│  └─────────────────────────┘                                 │
└───────────────────────────────────────────────────────────────┘
```

### 关键 JVM 内存参数

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `-Xms` | 物理内存 1/64 | 初始堆大小 |
| `-Xmx` | 物理内存 1/4 | 最大堆大小 |
| `-Xss` | 512KB~1MB | 每线程栈大小 |
| `-XX:MaxMetaspaceSize` | 无限制 | Metaspace 最大值 |
| `-XX:MaxDirectMemorySize` | 等于 -Xmx | DirectByteBuffer 上限 |
| `-XX:ReservedCodeCacheSize` | 240MB | JIT 代码缓存上限 |
| `-XX:NativeMemoryTracking=detail` | 关闭 | 启用 NMT 追踪 |

### 使用 NMT 分析 JVM 内存

```bash
# 启动时开启 NMT
java -XX:NativeMemoryTracking=detail -jar app.jar

# 查看内存摘要
$ jcmd <pid> VM.native_memory summary

# 查看详细信息（包含基线对比）
$ jcmd <pid> VM.native_memory detail

# 设置基线，后续对比差异
$ jcmd <pid> VM.native_memory baseline
# ... 运行一段时间 ...
$ jcmd <pid> VM.native_memory summary.diff
```

NMT 输出示例：

```text
                         Total  reserved    committed
-        Java Heap (reserved+committed):  2048000K +  2048000K
                        (mmap: reserved=2048000K, committed=2048000K)

-            Class (reserved+committed):   245760K +    49152K
                       (classes #12000)
                      (malloc=4096K  #1000)
                     (mmap: reserved=241664K, committed=45056K)

-           Thread (reserved+committed):   393216K +    393216K
                      (thread #384)
                      (stack: reserved=391168K, committed=391168K)
                   (malloc=1536K  #384)
                      (arena=512K  #768)

-              GC (reserved+committed):   307200K +    65536K
                   (malloc=57344K  #800)
                     (mmap: reserved=249856K, committed=8192K)

-        Internal (reserved+committed):    12288K +    12288K
                   (malloc=12288K  #1200)

-        Compiler (reserved+committed):     4096K +     4096K
                   (malloc=4096K  #300)
```

> **关键洞察**：当 Java Heap 稳定但 RSS 持续上涨时，问题往往在 Metaspace、Thread Stack、DirectByteBuffer 或 glibc arena 碎片中。NMT 是定位这类问题的首选工具。

## 3.2 Go 运行时：mcache → mcentral → mheap

Go 的内存分配器源自 Google 的 **TCMalloc**（Thread-Caching Malloc），采用了三级缓存架构：

```text
Go 内存分配三级缓存

┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   P0 mcache  │   │   P1 mcache  │   │   P2 mcache  │  ← 每个 P（处理器）私有
│  ┌─────────┐ │   │  ┌─────────┐ │   │  ┌─────────┐ │     无锁，线程安全
│  │ mspan[] │ │   │  │ mspan[] │ │   │  │ mspan[] │ │
│  │ sizeclass│ │   │  │ sizeclass│ │   │  │ sizeclass│ │
│  │  8B     │ │   │  │  8B     │ │   │  │  8B     │ │
│  │  16B    │ │   │  │  16B    │ │   │  │  16B    │ │
│  │  32B    │ │   │  │  32B    │ │   │  │  32B    │ │
│  │  ...    │ │   │  │  ...    │ │   │  │  ...    │ │
│  │  32KB   │ │   │  │  32KB   │ │   │  │  32KB   │ │
│  └─────────┘ │   │  └─────────┘ │   │  └─────────┘ │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                   │
       └──────────┬───────┴───────────────────┘
                  ↓ 缓存耗尽时从 mcentral 获取
       ┌──────────────────────────────┐
       │         mcentral              │  ← 全局，需要锁
       │  按 sizeclass 组织 mspan      │
       │  有空闲 object 的 mspan 链表  │
       └──────────────┬───────────────┘
                      ↓ mcentral 也没有时
       ┌──────────────────────────────┐
       │          mheap                │  ← 全局堆，从 OS 申请
       │  ┌─────────────────────────┐ │
       │  │  arena (64MB 一块)       │ │  ← 按 arena 管理
       │  │  ┌───┬───┬───┬───┬───┐ │ │
       │  │  │   │   │   │   │   │ │ │
       │  │  │span│span│span│span│ │ │  ← 每个 span 包含连续 pages
       │  │  └───┴───┴───┴───┴───┘ │ │
       │  └─────────────────────────┘ │
       └──────────────────────────────┘
```

### Go 的对象大小分类

```text
┌────────────────────────────────────────────────────────────┐
│  微对象 (Tiny)   : < 16 字节  → 合并到 16B slot 中         │
│  小对象 (Small)  : 16B ~ 32KB → 从 mcache 的 span 分配    │
│  大对象 (Large)  : > 32KB     → 直接从 mheap 分配          │
└────────────────────────────────────────────────────────────┘
```

### Go 的内存归还策略

Go 不像 glibc 那样"分配了就不还"。Go 运行时会定期将空闲内存归还给操作系统：

```go
// 环境变量控制归还行为
GODEBUG=madvdontneed=1  // 1.16 之前：使用 MADV_DONTNEED 立即归还
                        // 1.16+ 默认：使用 MADV_FREE 延迟归还

// 通过 debug 包控制
import "runtime/debug"

debug.SetGCPercent(100)           // GC 触发阈值（默认 100）
debug.SetMemoryLimit(1 << 30)    // Go 1.19+ 软内存限制
debug.FreeOSMemory()             // 强制 GC 并归还内存
```

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `GOGC` | 100 | 堆增长百分比触发 GC |
| `GOMEMLIMIT` | 无限制 | Go 1.19+ 软内存限制 |
| `GODEBUG=madvdontneed=1` | 关闭(1.16+) | 使用 MADV_DONTNEED 立即归还 |
| `debug.SetMaxThreads()` | 10000 | 最大 OS 线程数 |

## 3.3 Python 内存：pymalloc + 对象池

CPython 的内存管理是多层结构：

```text
CPython 内存管理架构

┌──────────────────────────────────────────────────┐
│                 Python 对象层                      │
│   list, dict, str, int, float ...                │
│   每个对象都有 PyObject 头部 (16B on 64-bit)      │
├──────────────────────────────────────────────────┤
│              Python 对象分配器                     │
│   PyObject_Malloc() → 小对象：pymalloc            │
│                     → 大对象：系统 malloc           │
├──────────────────────────────────────────────────┤
│               pymalloc 分配器                     │
│   ┌──────────────────────────────────────────┐   │
│   │ Arena (256KB)                            │   │
│   │  ┌─────────────────────────────────┐    │   │
│   │  │ Pool (4KB = 一个系统页)          │    │   │
│   │  │  ┌──┬──┬──┬──┬──┬──┬──┬──┐    │    │   │
│   │  │  │8B│8B│8B│8B│8B│8B│8B│8B│    │    │   │   ← 8 字节对象的 pool
│   │  │  └──┴──┴──┴──┴──┴──┴──┴──┘    │    │   │
│   │  └─────────────────────────────────┘    │   │
│   │  ┌─────────────────────────────────┐    │   │
│   │  │ Pool (4KB)                       │    │   │
│   │  │  ┌────┬────┬────┬────┐          │    │   │
│   │  │  │ 16B│ 16B│ 16B│ 16B│          │    │   │   ← 16 字节对象的 pool
│   │  │  └────┴────┴────┴────┘          │    │   │
│   │  └─────────────────────────────────┘    │   │
│   └──────────────────────────────────────────┘   │
│   对象大小分类：8B, 16B, 24B, ... 512B (8B 递增) │
├──────────────────────────────────────────────────┤
│                 系统分配器                         │
│   glibc malloc / jemalloc                        │
├──────────────────────────────────────────────────┤
│               操作系统                             │
│   brk() / mmap()                                 │
└──────────────────────────────────────────────────┘
```

### Python 内存优化要点

```python
# 1. 使用 __slots__ 减少对象内存开销
class Point:
    __slots__ = ['x', 'y']  # 避免 __dict__，每个实例节省 ~100B
    def __init__(self, x, y):
        self.x = x
        self.y = y

# 2. 使用 sys.getsizeof 查看对象大小
import sys
sys.getsizeof([])           # 56 bytes（空 list）
sys.getsizeof([1]*1000)     # 8056 bytes

# 3. 使用 tracemalloc 追踪内存分配
import tracemalloc
tracemalloc.start()
# ... 执行代码 ...
snapshot = tracemalloc.take_snapshot()
for stat in snapshot.statistics('lineno')[:10]:
    print(stat)

# 4. 使用 gc 模块控制垃圾回收
import gc
gc.set_threshold(700, 10, 10)  # 调整 GC 触发阈值
gc.collect()                     # 手动触发 GC
gc.disable()                     # 禁用自动 GC（需要手动管理）
```

## 3.4 Node.js 内存：V8 堆与 ArrayBuffer

Node.js 使用 V8 引擎，其内存管理分为堆内存和堆外内存：

```text
Node.js / V8 内存结构

┌───────────────────────────────────────────────────────┐
│                  V8 堆内存 (-Xmx)                      │
│  ┌─────────────────────────────────────────────────┐  │
│  │  新生代 (New Space)     默认 1~8MB              │  │
│  │  ┌──────────┬──────────┐                        │  │
│  │  │  Semi    │  Semi    │  ← Scavenge GC        │  │
│  │  │  Space A │  Space B │    (minor GC)          │  │
│  │  └──────────┴──────────┘                        │  │
│  ├─────────────────────────────────────────────────┤  │
│  │  老生代 (Old Space)     默认 最大 1.4GB(64位)   │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │  Old Pointer Space │ Old Data Space       │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  │  ← Mark-Sweep / Mark-Compact GC (major GC)     │  │
│  ├─────────────────────────────────────────────────┤  │
│  │  Code Space            ← JIT 编译的代码         │  │
│  │  Map Space             ← Hidden Classes         │  │
│  │  Large Object Space    ← > 256KB 的对象          │  │
│  └─────────────────────────────────────────────────┘  │
├───────────────────────────────────────────────────────┤
│              堆外内存 (Off-Heap)                        │
│  ┌─────────────────────────────────────────────────┐  │
│  │  ArrayBuffer / Buffer                           │  │
│  │  ← 通过 malloc 分配，不计入 V8 堆限制           │  │
│  │  ← 受 V8 的 ArrayBuffer allocator 限制          │  │
│  ├─────────────────────────────────────────────────┤  │
│  │  Native C++ Objects (libuv, zlib, crypto)       │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

### Node.js 内存调优

```bash
# 设置老生代堆大小上限
node --max-old-space-size=4096 app.js  # 4GB

# 设置新生代大小
node --max-semi-space-size=64 app.js   # 64MB

# 查看 GC 日志
node --trace-gc --trace-gc-verbose app.js

# 使用 --inspect 连接 Chrome DevTools 进行堆分析
node --inspect app.js
```

```javascript
// 运行时查看内存使用
console.log(process.memoryUsage());
// {
//   rss: 48000000,              ← 进程总内存（含堆外）
//   heapTotal: 18000000,        ← V8 堆总大小
//   heapUsed: 8000000,          ← V8 堆已使用
//   external: 1200000,          ← C++ 对象绑定的内存
//   arrayBuffers: 500000        ← ArrayBuffer/SharedArrayBuffer
// }

// V8 堆快照分析
const v8 = require('v8');
const fs = require('fs');
const snapshot = v8.writeHeapSnapshot();
console.log(`Heap snapshot written to ${snapshot}`);
// 用 Chrome DevTools 的 Memory tab 打开 .heapsnapshot 文件
```

**本章要点：**

- **JVM 内存远大于 Heap**：Metaspace、Thread Stack、Code Cache、DirectByteBuffer、glibc arena 碎片共同构成 RSS
- **Go 采用 TCMalloc 架构**：mcache（无锁）→ mcentral（有锁）→ mheap（全局），Go 1.19 引入 GOMEMLIMIT 是重大改进
- **Python 的 pymalloc** 管理 8B~512B 的小对象，大于 512B 的对象直接调用系统 malloc
- **V8 堆有硬上限**：老生代默认 1.4GB，需通过 `--max-old-space-size` 调整；Buffer 是堆外内存，不受此限制
- **每种语言运行时都有"隐藏"的内存消耗**，不能只看应用层指标

---

# 第 4 章：内核内存分配机制深入

## 4.1 页错误处理：demand paging 的实现

Linux 使用 **按需分页（demand paging）** 机制：当进程访问一个虚拟地址但对应的物理页尚未分配时，CPU 触发 **缺页异常（page fault）**，由内核处理。

### 4.1.1 缺页异常的处理流程

```text
用户态访问虚拟地址
        │
        ↓
  CPU 查找页表 ──→ 找到 PTE？──→ 页在内存中？──→ 正常访问
        │                   │
        │                   ↓ No
        │              PTE 存在但
        │              Present=0？
        │                   │
        ├───────────────────┤
        ↓                   ↓
   页不在页表中         minor fault
   (无效地址)          (页被 swap out
        │              或 COW)
        ↓                   ↓
   major fault        检查 VMA
   (需要从磁盘        (vm_area_struct)
    读取页面)              │
        │              ┌───┴───┐
        ↓              ↓       ↓
   do_swap_page    匿名页    文件页
                   检查 swap  从 page cache
                   cache      或磁盘读取
```

内核源码路径（基于 Linux 5.x+）：

```text
mm/memory.c
  ├── handle_mm_fault()           ← 缺页异常入口
  │   ├── __handle_mm_fault()
  │   │   ├── handle_pte_fault()    ← PTE 级别处理
  │   │   │   ├── do_fault()        ← 文件映射页错误
  │   │   │   ├── do_swap_page()    ← swap 换入
  │   │   │   ├── do_wp_page()      ← Copy-on-Write
  │   │   │   └── do_anonymous_page() ← 匿名页首次分配
  │   │   └── handle_pmd_fault()    ← PMD 级别处理
  │   └── 返回 VM_FAULT_xxx 结果
```

### 4.1.2 minor fault vs major fault

| 类型 | 触发条件 | 开销 | 说明 |
|------|---------|------|------|
| **minor fault** | 首次访问匿名页 / COW / 页在 page cache 中 | ~几微秒 | 不需要磁盘 I/O |
| **major fault** | 页被 swap out / 需要从磁盘读取文件 | ~几毫秒 | 需要磁盘 I/O，性能影响大 |

```bash
# 查看进程的 page fault 统计
$ ps -o pid,min_flt,maj_flt -p <pid>
  PID  MINFL  MAJFL
12345 123456    789

# 使用 perf 统计 page fault
$ perf stat -e page-faults,major-faults,minor-faults -p <pid> sleep 10

# 使用 sar 查看系统级 page fault
$ sar -B 1 5
```

## 4.2 内存回收路径：kswapd → direct reclaim → OOM

当系统内存不足时，Linux 按照以下路径逐步升级回收力度：

```text
内存压力升级路径

┌─────────────────────────────────────────────────────────────────┐
│  水位线 (Watermarks)                                            │
│                                                                 │
│  ┌───────────┐ high watermark                                  │
│  │           │ ← kswapd 唤醒：后台异步回收                       │
│  │  安全区    │                                                  │
│  │           │                                                  │
│  ├───────────┤ low watermark                                   │
│  │           │ ← 直接回收 (direct reclaim)：同步阻塞回收         │
│  │  危险区    │                                                  │
│  │           │                                                  │
│  ├───────────┤ min watermark                                   │
│  │  紧急区    │ ← 仅保留给紧急分配 (__GFP_HIGH)                  │
│  ├───────────┤                                                  │
│  │           │ ← OOM Killer：杀进程释放内存                     │
│  └───────────┘                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2.1 kswapd：后台异步回收

```c
/* mm/vmscan.c */
static int kswapd(void *p)
{
    /* kswapd 在后台运行，当空闲内存低于 low watermark 时唤醒 */
    /* 扫描 LRU 链表，回收不活跃的页面 */
    /* 目标：将空闲内存恢复到 high watermark */
}
```

### 4.2.2 direct reclaim：同步直接回收

当进程申请内存时，如果空闲内存低于 min watermark，当前进程会被阻塞并直接参与内存回收：

```c
/* mm/page_alloc.c */
__alloc_pages_slowpath()
{
    /* 1. 尝试唤醒 kswapd */
    wake_all_kswapds(order, gfp_mask, ac);

    /* 2. 尝试直接回收 */
    page = __alloc_pages_direct_reclaim(gfp_mask, order, ...);

    /* 3. 尝试内存压缩 (compaction) */
    page = __alloc_pages_direct_compact(gfp_mask, order, ...);

    /* 4. 其他措施：OOM Killer */
    page = __alloc_pages_may_oom(gfp_mask, order, ...);
}
```

### 4.2.3 OOM Killer 机制

OOM Killer 选择进程的依据是 **oom_score**：

```bash
# 查看进程的 OOM 分数
$ cat /proc/<pid>/oom_score
# 0~1000，分数越高越可能被杀

# 设置 OOM 分数调整值（-1000 到 1000）
$ echo -500 > /proc/<pid>/oom_score_adj

# 永久禁止 OOM 杀死某个进程
$ echo -1000 > /proc/<pid>/oom_score_adj

# 查看 OOM 事件日志
$ dmesg | grep -i "out of memory"
$ journalctl -k | grep -i "oom"
```

OOM 分数计算核心逻辑：

```text
oom_score = 进程 RSS + swap 使用量 + 子进程内存（部分计入）
           ──────────────────────────────────────────────
                        总可用内存

oom_score_adj 范围：-1000 ~ 1000
  -1000: 永远不杀（OOM_SCORE_ADJ_MIN）
     0: 默认
  1000: 最高优先级被杀
```

## 4.3 内存压缩（compaction）与透明大页（THP）

### 4.3.1 内存压缩

当系统中有足够的空闲内存但分散在不连续的页面中时，无法满足高阶分配（order > 0）。内存压缩通过移动可移动页面，将空闲页面合并为连续区域。

```text
内存压缩前后对比

压缩前：
┌──┬──┬──┬空闲┬──┬空闲┬──┬空闲┬──┬──┬──┬空闲┬──┬──┐
│  │  │  │    │  │    │  │    │  │  │  │    │  │  │
└──┴──┴──┘    └──┘    └──┘    └──┴──┴──┘    └──┴──┘

压缩后：
┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬空闲┬空闲┬空闲┬空闲│
│  │  │  │  │  │  │  │  │  │  │  │    │    │    │    │
└──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┘    └────┴────┴────┘
```

```bash
# 查看内存压缩统计
$ grep -i compact /proc/vmstat
compact_success 12345
compact_fail 678
compact_stall 0        # direct compaction 触发次数（越少越好）

# 控制内存压缩行为
$ echo 1 > /proc/sys/vm/compact_memory    # 手动触发全系统压缩
$ echo 0 > /proc/sys/vm/compaction_proactiveness  # 禁用主动压缩
```

### 4.3.2 透明大页（THP）

透明大页（Transparent Huge Pages）允许内核自动将 4KB 小页合并为 2MB 大页，减少 TLB miss。

```text
THP 工作原理

普通 4KB 页：                    THP 2MB 页：
┌────┐  TLB entry               ┌───────────────────┐  1 个 TLB entry
│ 4K │  × 512 = 512 个 entry    │                   │  覆盖 2MB
├────┤                           │                   │
│ 4K │                           │                   │
├────┤                           │                   │
│...│                           │                   │
├────┤                           │                   │
│ 4K │  = 2MB                   └───────────────────┘
└────┘                           512 个 4KB 页合并为 1 个 2MB 页
```

```bash
# 查看 THP 状态
$ cat /sys/kernel/mm/transparent_hugepage/enabled
[always] madvise never

# 设置 THP 模式
$ echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
# always: 全局启用（可能导致延迟抖动）
# madvise: 仅在 madvise(MADV_HUGEPAGE) 标记的区域启用（推荐）
# never: 完全禁用

# 查看 THP 使用情况
$ grep -i huge /proc/meminfo
AnonHugePages:    524288 kB    # 匿名 THP 使用量
ShmemHugePages:        0 kB
HugePages_Total:       0       # 预分配大页数量
HugePages_Free:        0
Hugepagesize:       2048 kB    # 大页大小
```

> **THP 的隐患**：THP 的 khugepaged 线程会在后台合并小页为大页，这个过程会导致延迟抖动。很多数据库（Redis、MongoDB、MySQL）官方文档建议将 THP 设置为 `madvise` 或 `never`。

## 4.4 NUMA 感知的内存分配

在 NUMA（Non-Uniform Memory Access）架构下，不同 CPU 访问不同内存节点的延迟不同：

```text
NUMA 架构示意（双路服务器）

  Node 0                          Node 1
┌──────────────┐               ┌──────────────┐
│  CPU 0-15    │               │  CPU 16-31   │
│  L3 Cache    │               │  L3 Cache    │
│  ┌────────┐  │   QPI/UPI    │  ┌────────┐  │
│  │Memory  │  │ ←──────────→ │  │Memory  │  │
│  │32 GB   │  │   ~100ns     │  │32 GB   │  │
│  └────────┘  │  远端访问     │  └────────┘  │
└──────────────┘               └──────────────┘

本地访问：~80ns    跨节点访问：~150ns（约 1.8 倍）
```

```bash
# 查看 NUMA 拓扑
$ numactl --hardware
available: 2 nodes (0-1)
node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
node 0 size: 32768 MB
node 1 cpus: 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
node 1 size: 32768 MB

# 查看进程的 NUMA 内存分布
$ cat /proc/<pid>/numa_maps | head -20
00400000 default file=/usr/bin/app mapped=10 N0=5 N1=5
7f1234000000 default anon=512 dirty=512 N0=480 N1=32

# 使用 numactl 控制 NUMA 策略
$ numactl --interleave=all ./app         # 交错分配到所有节点
$ numactl --membind=0 ./app              # 只使用 node 0 的内存
$ numactl --cpunodebind=0 --membind=0 ./app  # CPU 和内存绑定到同一节点

# 查看 NUMA 统计
$ numastat -p <pid>
```

NUMA 内存分配策略：

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| `default` | 在当前 CPU 所在节点分配 | 大多数场景 |
| `bind` | 只在指定节点分配 | 对延迟敏感的服务 |
| `interleave` | 轮询分配到所有节点 | 大内存应用（数据库） |
| `preferred` | 优先在指定节点，不够则使用其他节点 | 平衡场景 |

**本章要点：**

- **Demand paging** 是 Linux 内存分配的基础：只有实际访问时才分配物理页，minor fault 不涉及磁盘 I/O
- **内存回收有三级路径**：kswapd（后台异步）→ direct reclaim（同步阻塞）→ OOM Killer（杀进程）
- **THP 虽然减少 TLB miss**，但 khugepaged 的合并操作会导致延迟抖动，数据库建议 `madvise` 或 `never`
- **NUMA 跨节点访问延迟约为本地的 1.8 倍**，关键服务应绑定 CPU 和内存到同一节点
- **理解内核源码路径**（`mm/vmscan.c`、`mm/page_alloc.c`、`mm/memory.c`）有助于深入分析内存问题

---

# 第 5 章：cgroup memory 与容器内存管理

## 5.1 cgroup v1 vs v2 内存控制器

容器的内存隔离依赖 Linux cgroup 内存控制器。cgroup v1 和 v2 在路径、接口和功能上有显著差异。

### 5.1.1 cgroup v1 内存控制器

```text
cgroup v1 内存控制器路径

/sys/fs/cgroup/memory/
├── docker/                        ← Docker 容器
│   └── <container_id>/
│       ├── memory.limit_in_bytes  ← 内存硬限制
│       ├── memory.soft_limit_in_bytes ← 内存软限制
│       ├── memory.usage_in_bytes  ← 当前使用量
│       ├── memory.max_usage_in_bytes ← 历史峰值
│       ├── memory.failcnt         ← 达到限制的次数
│       ├── memory.stat            ← 详细统计
│       ├── memory.oom_control     ← OOM 控制
│       ├── memory.swappiness      ← swap 倾向
│       └── cgroup.procs           ← 包含的进程列表
```

```bash
# cgroup v1：查看容器内存限制
$ cat /sys/fs/cgroup/memory/docker/<container_id>/memory.limit_in_bytes
2147483648  # 2GB

# cgroup v1：查看当前内存使用
$ cat /sys/fs/cgroup/memory/docker/<container_id>/memory.usage_in_bytes
1073741824  # 1GB

# cgroup v1：查看详细统计
$ cat /sys/fs/cgroup/memory/docker/<container_id>/memory.stat
cache 123456789
rss 987654321
mapped_file 12345678
pgfault 12345
pgmajfault 678
inactive_anon 500000000
active_anon 600000000
inactive_file 100000000
active_file 50000000
```

### 5.1.2 cgroup v2 内存控制器

```text
cgroup v2 内存控制器路径

/sys/fs/cgroup/
├── system.slice/                  ← systemd 管理的 cgroup
│   └── docker-<id>.scope/
│       ├── memory.max             ← 内存硬限制 ("max" 表示无限制)
│       ├── memory.low             ← 内存保护（best-effort 下限）
│       ├── memory.high            ← 内存高压阈值（触发回收，不 OOM）
│       ├── memory.current         ← 当前使用量
│       ├── memory.peak            ← 历史峰值
│       ├── memory.stat            ← 详细统计
│       ├── memory.swap.max        ← swap 限制
│       ├── memory.swap.current    ← 当前 swap 使用量
│       ├── memory.pressure        ← PSI 内存压力指标
│       └── cgroup.procs
```

```bash
# cgroup v2：查看容器内存限制
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.max
2147483648  # 2GB

# cgroup v2：查看当前使用
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.current
1073741824

# cgroup v2：设置内存限制
$ echo "2G" > /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.max
$ echo "1G" > /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.high
```

### 5.1.3 cgroup v1 vs v2 关键差异

| 特性 | cgroup v1 | cgroup v2 |
|------|----------|----------|
| **路径格式** | `/sys/fs/cgroup/memory/<group>/` | `/sys/fs/cgroup/<group>/` |
| **硬限制** | `memory.limit_in_bytes` | `memory.max` |
| **高压阈值** | 无 | `memory.high`（新增，触发回收但不 OOM） |
| **保护下限** | `memory.soft_limit_in_bytes` | `memory.low`（新增，更可靠的保护） |
| **PSI 支持** | 不支持 | `memory.pressure`（新增） |
| **swap 控制** | `memory.memsw.limit_in_bytes` | `memory.swap.max` |
| **层级模型** | 多层级（multi-hierarchy） | 统一层级（unified hierarchy） |

> **cgroup v2 的 `memory.high` 是一个重要的改进**：当内存使用超过 `memory.high` 时，进程会被节流（throttle），触发同步回收，但不会被 OOM 杀死。这比 v1 中"要么不限制、要么直接 OOM"的二元选择更加优雅。

## 5.2 内存统计：RSS、cache、swap 的 cgroup 视角

### 5.2.1 cgroup v1 memory.stat 字段解析

```text
cgroup v1 memory.stat 关键字段

cache              ← Page cache（文件缓存），可回收
rss                ← 匿名页（Anonymous pages），不可回收
mapped_file        ← mmap 映射的文件页
pgfault            ← 缺页异常总次数
pgmajfault         ← major fault 次数（磁盘 I/O）
inactive_anon      ← 不活跃的匿名页（swap 候选）
active_anon        ← 活跃的匿名页
inactive_file      ← 不活跃的文件页（回收优先级最高）
active_file        ← 活跃的文件页
unevictable        ← 不可回收的页（mlock 等）
```

**关键公式**：

```text
容器"真实"内存使用 = rss + cache（不含共享库共享部分）

内存限制计费 = memory.usage_in_bytes
             = rss + cache + swap（如果启用了 memsw）
             = 所有匿名页 + 所有文件缓存 + swap 使用

# 这就是为什么 "free -m" 看到的 buffer/cache 在容器内会被计入内存限制！
```

### 5.2.2 容器内存使用的正确理解

```text
容器内存计费模型

┌─────────────────────────────────────────────────────────┐
│                  memory.limit = 2GB                      │
│                                                         │
│  ┌──────────────────────┐                               │
│  │    RSS (匿名页)       │  ← 进程实际数据/堆/栈         │
│  │    ~800MB            │                               │
│  ├──────────────────────┤                               │
│  │    Cache (文件缓存)   │  ← 读写文件产生的缓存         │
│  │    ~600MB            │                               │
│  ├──────────────────────┤                               │
│  │    Swap              │  ← 被换出的匿名页             │
│  │    ~100MB            │                               │
│  ├──────────────────────┤                               │
│  │    Kernel (slab等)   │  ← 内核对象占用（部分计入）    │
│  │    ~50MB             │                               │
│  └──────────────────────┘                               │
│  总使用 ≈ 1550MB                                        │
│  距离 2GB 限制还有 450MB                                 │
└─────────────────────────────────────────────────────────┘
```

## 5.3 内存压力（PSI）与 OOM

### 5.3.1 PSI（Pressure Stall Information）

PSI 是 Linux 4.20+ 引入的资源压力指标，可以精确衡量内存压力：

```bash
# 系统级 PSI
$ cat /proc/pressure/memory
some avg10=0.00 avg60=0.00 avg300=0.00 total=123456
full avg10=0.00 avg60=0.00 avg300=0.00 total=78901

# cgroup v2 容器级 PSI
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.pressure
some avg10=2.50 avg60=1.20 avg300=0.50 total=4567890
full avg10=0.80 avg60=0.30 avg300=0.10 total=1234567
```

PSI 字段说明：

| 字段 | 含义 |
|------|------|
| `some` | 至少有一个任务因内存不足而等待的时间百分比 |
| `full` | 所有非空闲任务都因内存不足而等待的时间百分比 |
| `avg10` | 最近 10 秒的平均值 |
| `avg60` | 最近 60 秒的平均值 |
| `avg300` | 最近 300 秒的平均值 |
| `total` | 累计等待时间（微秒） |

### 5.3.2 cgroup v2 的分层内存控制

cgroup v2 支持更精细的内存控制层次：

```text
memory.low  →  内存保护线（best-effort 保证）
memory.high →  高压线（触发回收，进程被节流）
memory.max  →  硬限制（超过触发 OOM）

                  memory.low    memory.high    memory.max
                       │             │              │
  使用量:   ────────+──┼─────────────┼──────────────┼──→
            安全     │  受保护      │   被节流     │ OOM!
                     │             │              │
                     │  best-effort │  throttle +  │
                     │  保证       │  reclaim     │
```

## 5.4 容器内存问题的常见模式

### 5.4.1 模式一：cache 导致的 OOM

```text
问题：容器限制 2GB，应用本身只用 1GB，但因为读写文件产生了 1.2GB 的 cache
结果：1GB RSS + 1.2GB cache = 2.2GB > 2GB limit → OOM
```

```bash
# 诊断：检查 cache 是否占大头
$ cat /sys/fs/cgroup/memory/docker/<id>/memory.stat | grep -E "cache|rss"
cache 1258291200    # 1.2GB
rss 1073741824      # 1.0GB

# 解决方案 1：增加内存限制
# 解决方案 2：定期清理 cache（不推荐，影响性能）
# 解决方案 3：cgroup v2 使用 memory.high + memory.low 分层保护
```

### 5.4.2 模式二：JVM Heap 之外的 Native Memory 泄漏

```text
问题：JVM -Xmx=2GB，Heap 使用 1.5GB 稳定
      但容器 RSS 持续上涨，最终触发 3GB 的 OOM
根因：Native 代码（JNI、Netty DirectBuffer、glibc 碎片）泄漏
```

### 5.4.3 模式三：init 进程内存计算

```text
问题：容器使用 bash/sh 作为 entrypoint
      它 fork 出的子进程内存都被计入 init 进程的 cgroup
结果：整个 cgroup 内存 = 所有进程内存之和
      当一个 Pod 有 sidecar 时，所有容器共享同一个 cgroup（或各自的子 cgroup）
```

**本章要点：**

- **cgroup v1 和 v2 的路径、接口完全不同**，v2 新增了 `memory.high`（节流）和 `memory.low`（保护）两个重要层级
- **容器内存计费包含 cache**：文件 I/O 操作产生的 page cache 会被计入内存限制
- **PSI 是衡量内存压力的最精确指标**，比简单的 free/used 百分比更有参考价值
- **cgroup v2 的分层控制**（low → high → max）比 v1 的单一限制更加灵活和安全
- **容器 OOM 不代表宿主机内存不足**，往往是 cache、Native Memory 或碎片导致

---

# 第 6 章：内存分析工具与方法论

## 6.1 /proc 文件系统：进程内存的真相

`/proc` 是分析进程内存的第一信息源，它提供了内核视角的精确数据。

### 6.1.1 /proc/[pid]/status

```bash
$ cat /proc/<pid>/status | grep -i mem
VmPeak:  12345678 kB    ← 虚拟内存峰值
VmSize:  12345678 kB    ← 当前虚拟内存大小
VmLck:         0 kB    ← mlock 锁定的内存
VmPin:         0 kB    ← pinned 内存
VmHWM:    1234567 kB    ← RSS 峰值（High Water Mark）
VmRSS:    1234567 kB    ← 当前 RSS
RssAnon:   800000 kB    ← 匿名页 RSS（堆、栈等）
RssFile:   400000 kB    ← 文件映射 RSS（共享库等）
RssShmem:   34567 kB    ← 共享内存 RSS
VmData:    800000 kB    ← 数据段大小
VmStk:       136 kB    ← 栈大小
VmExe:      5678 kB    ← 代码段大小
VmLib:    123456 kB    ← 共享库大小
VmPTE:      1234 kB    ← 页表大小
VmSwap:    12345 kB    ← swap 使用量
```

### 6.1.2 /proc/[pid]/statm 与 /proc/[pid]/stat

```bash
# statm 提供简洁的内存统计（单位：页，通常 4KB）
$ cat /proc/<pid>/statm
1234567 123456 45678 1234 0 567890 0
#     ↓       ↓      ↓     ↓   ↓     ↓    ↓
#  total   resident shared text lib  data  dt

# stat 中的 page fault 计数（第 10 和第 12 字段）
$ cat /proc/<pid>/stat | awk '{print "minflt="$10, "majflt="$12}'
minflt=123456 majflt=789
```

### 6.1.3 /proc/meminfo

```bash
$ cat /proc/meminfo
MemTotal:       65536000 kB    ← 物理内存总量
MemFree:         8192000 kB    ← 完全空闲的内存
MemAvailable:   32768000 kB    ← 可用内存（含可回收的 cache）
Buffers:          512000 kB    ← 块设备缓存
Cached:         16384000 kB    ← Page cache
SwapCached:       12345 kB    ← 已在 swap 中但仍保留在内存的页
Active:         24576000 kB    ← 活跃页
Inactive:       12288000 kB    ← 不活跃页（回收优先考虑）
SwapTotal:       8192000 kB    ← swap 总量
SwapFree:        7680000 kB    ← swap 剩余
Dirty:             12345 kB    ← 等待写回磁盘的脏页
Slab:            2048000 kB    ← 内核 slab 分配器总量
SReclaimable:    1536000 kB    ← 可回收的 slab
SUnreclaim:       512000 kB    ← 不可回收的 slab
```

> **MemAvailable vs MemFree**：`MemFree` 是完全空闲的内存，`MemAvailable` 是内核估算的"可分配给用户空间而不触发 swap 的内存量"。**MemAvailable 才是真正有参考价值的指标**。

## 6.2 smaps 与 pmap：详细的内存映射分析

### 6.2.1 /proc/[pid]/smaps

`smaps` 提供了每个 VMA（虚拟内存区域）的详细信息，是精确分析内存使用的关键工具：

```bash
$ head -40 /proc/<pid>/smaps
7f1234000000-7f1238000000 rw-p 00000000 00:00 0
Size:              65536 kB    ← 虚拟大小
KernelPageSize:        4 kB
MMUPageSize:           4 kB
Rss:               32768 kB    ← 驻留物理内存
Pss:               32768 kB    ← 按比例分摊的物理内存（共享页平分）
Shared_Clean:          0 kB    ← 共享且未修改
Shared_Dirty:          0 kB    ← 共享且已修改
Private_Clean:         0 kB    ← 私有且未修改
Private_Dirty:     32768 kB    ← 私有且已修改
Referenced:        32768 kB    ← 最近被访问
Anonymous:         32768 kB    ← 匿名页
LazyFree:              0 kB    ← MADV_FREE 标记的页
AnonHugePages:     16384 kB    ← 匿名透明大页
ShmemPmdMapped:        0 kB
Shared_Hugetlb:        0 kB
Private_Hugetlb:       0 kB
Swap:                  0 kB    ← 被换出的量
SwapPss:               0 kB    ← 按比例分摊的 swap
Locked:                0 kB
```

### 6.2.2 pmap 命令

```bash
# 简洁视图
$ pmap <pid>
# 输出：每个 VMA 的地址范围、大小、映射模式、映射文件

# 详细视图（等价于 smaps）
$ pmap -x <pid>

# 汇总视图
$ pmap -X <pid>

# 按大小排序找出最大的映射
$ pmap -x <pid> | sort -k 3 -n -r | head -20
```

### 6.2.3 smaps_rollup（Linux 4.14+）

```bash
$ cat /proc/<pid>/smaps_rollup
7fff12340000-7fff56780000 ---p 00000000 00:00 0    [stack]
Rss:              8192 kB
Pss:              8192 kB
Pss_Anon:         8192 kB
Pss_File:            0 kB
Pss_Shmem:           0 kB
Shared_Clean:        0 kB
Shared_Dirty:        0 kB
Private_Clean:       0 kB
Private_Dirty:    8192 kB
Referenced:       8192 kB
Anonymous:        8192 kB
Swap:                0 kB
```

> **PSS 是跨进程内存归因的最准确指标**：如果一个 10MB 的共享库被 5 个进程加载，每个进程的 PSS 中只计 2MB。

## 6.3 perf 与 eBPF：内核级内存追踪

### 6.3.1 perf 内存分析

```bash
# 统计 page fault
$ perf stat -e page-faults,major-faults,minor-faults -p <pid> sleep 30

# 记录 page fault 事件
$ perf record -e page-faults -p <pid> sleep 10
$ perf report

# 使用 perf trace 追踪 brk/mmap 系统调用
$ perf trace -e brk,mmap,munmap -p <pid> --duration 10

# NUMA 相关分析
$ perf stat -e node-loads,node-load-misses,node-stores,node-store-misses -p <pid> sleep 10

# 内存带宽分析
$ perf stat -e uncore_imc/cas_count_read/,uncore_imc/cas_count_write/ -p <pid> sleep 10
```

### 6.3.2 eBPF 内存追踪工具

BCC（BPF Compiler Collection）提供了丰富的内存分析工具：

```bash
# 1. memleak：检测内存泄漏
$ /usr/share/bcc/tools/memleak -p <pid> -a 60  # 每 60 秒输出未释放的分配

# 2. cachestat：page cache 命中率
$ /usr/share/bcc/tools/cachestat 1  # 每秒输出 cache 统计

# 3. oomkill：跟踪 OOM 事件
$ /usr/share/bcc/tools/oomkill

# 4. slabratetop：slab 分配速率
$ /usr/share/bcc/tools/slabratetop

# 5. mallocstat（需要 USDT probe）
$ /usr/share/bcc/tools/mallocstat <pid>
```

使用 bpftrace 编写自定义内存追踪脚本：

```bash
# 追踪进程的 brk/mmap 调用
$ bpftrace -e '
tracepoint:syscalls:sys_enter_brk /pid == $1/ {
    printf("brk(addr=%lx) = ", args->brk);
}
tracepoint:syscalls:sys_exit_brk /pid == $1/ {
    printf("%lx\n", args->ret);
}
' <pid>

# 追踪 page fault 的分布
$ bpftrace -e '
software:page-fault:1 /pid == $1/ {
    @faults[comm, kstack] = count();
}
interval:s:10 {
    print(@faults);
    clear(@faults);
}' <pid>
```

## 6.4 valgrind 与 AddressSanitizer：内存错误检测

### 6.4.1 valgrind memcheck

```bash
# 基本内存泄漏检测
$ valgrind --leak-check=full --show-leak-kinds=all ./app

# 输出示例
==12345== HEAP SUMMARY:
==12345==     in use at exit: 1,024 bytes in 2 blocks
==12345==   total heap usage: 10 allocs, 8 frees, 8,192 bytes allocated
==12345==
==12345== 512 bytes in 1 blocks are definitely lost in loss record 1 of 2
==12345==    at 0x4C2AB80: malloc (in /usr/lib/valgrind/vgpreload_memcheck-amd64-linux.so)
==12345==    by 0x400541: main (app.c:15)

# 更精确的工具
$ valgrind --tool=massif ./app              # 堆内存分析
$ ms_print massif.out.<pid>                 # 可视化堆内存变化
$ valgrind --tool=drd ./app                 # 数据竞争检测
```

### 6.4.2 AddressSanitizer (ASan)

```bash
# 编译时启用 ASan
$ gcc -fsanitize=address -g -O1 app.c -o app
$ clang -fsanitize=address -g -O1 app.c -o app

# 运行程序（ASan 会自动报告错误）
$ ./app
=================================================================
==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x60200000eff4
    #0 0x4c2e10 in main app.c:15:5
    #1 0x7f123456782f in __libc_start_main
0x60200000eff4 is located 0 bytes to the right of 4-byte region [0x60200000eff0,0x60200000eff4)
allocated by thread T0 here:
    #0 0x4c2a80 in malloc
    #1 0x4c2e00 in main app.c:14:15

# 常用 ASan 选项
$ export ASAN_OPTIONS="detect_leaks=1:halt_on_error=0:log_path=asan_log"
$ ./app
```

### 6.4.3 工具选型对照

| 工具 | 运行时开销 | 检测能力 | 适用场景 |
|------|----------|---------|---------|
| **valgrind memcheck** | 10~50x | 内存泄漏、越界、未初始化 | 开发/测试环境 |
| **ASan** | 2x | 越界、UAF、泄漏 | CI/CD、开发环境 |
| **MSan** | 3x | 未初始化内存读取 | 开发环境 |
| **TSan** | 5~15x | 数据竞争 | 多线程调试 |
| **eBPF/memleak** | <5% | 生产环境泄漏检测 | 生产环境 |
| **perf** | <1% | page fault、NUMA | 生产环境 |

**本章要点：**

- **`/proc/[pid]/status` 和 `smaps` 是最可靠的内存信息源**，不要只看 `top` 或 `ps`
- **PSS 是跨进程内存归因的正确指标**，RSS 会重复计算共享页
- **eBPF 工具（memleak、cachestat）可以在生产环境低开销使用**
- **ASan 适合在 CI/CD 中集成**，2x 的运行时开销在测试中可以接受
- **MemAvailable 才是系统可用内存的准确指标**，MemFree 低估了可分配量

---

# 第 7 章：企业故障案例分析

## 7.1 案例 1：JVM RSS 持续上涨但 Heap 稳定

### 现象

某 Java 微服务部署在 K8s 上，容器内存限制为 3GB，`-Xmx=2GB`。

- 启动时 RSS 约 1.2GB
- 运行 3 天后 RSS 涨到 2.8GB
- `jcmd VM.native_memory summary` 显示 Heap committed 1.5GB，Metaspace 200MB
- **Heap 远未达上限，但 RSS 已接近容器限制**

### 假设

1. Metaspace 泄漏（类加载不停增长）
2. DirectByteBuffer 泄漏（Netty 等框架）
3. Thread Stack 增长（线程泄漏）
4. glibc arena 碎片

### 证据收集

```bash
# 1. NMT 分析
$ jcmd <pid> VM.native_memory summary
# 结果：Heap=1.5GB, Metaspace=200MB, Thread=400MB(400线程×1MB),
#       CodeCache=100MB, Direct=500MB, Internal=50MB
# 总计 ≈ 2.75GB，与 RSS 吻合

# 2. 发现 Direct Memory 500MB！检查 DirectByteBuffer
$ jcmd <pid> VM.native_memory summary.diff
# Direct 从初始 100MB 涨到 500MB

# 3. 线程数也在增长
$ ls /proc/<pid>/task/ | wc -l
# 从 200 涨到 400

# 4. 使用 pmap 确认大块匿名映射
$ pmap -x <pid> | sort -k 3 -n -r | head -20
# 发现多个 64MB 的匿名映射
```

### 根因

**Netty DirectByteBuffer 泄漏**：服务使用 Netty 做 HTTP 通信，某个错误处理路径没有正确 release ByteBuf，导致 DirectByteBuffer 持续增长。同时，线程池配置不当导致线程数从 200 涨到 400，额外消耗 200MB。

### 修复

```java
// 修复前：异常路径未释放 ByteBuf
try {
    doSomething(buf);
} catch (Exception e) {
    log.error("error", e);
    // buf 未 release！
}

// 修复后：确保所有路径释放 ByteBuf
try {
    doSomething(buf);
} catch (Exception e) {
    log.error("error", e);
} finally {
    if (buf != null && buf.refCnt() > 0) {
        buf.release();
    }
}
```

```bash
# 同时调整线程池配置
# 修复线程泄漏，将最大线程数限制为 200
# 调整 JVM 参数
-XX:MaxDirectMemorySize=256m  # 限制 Direct Memory
-XX:+UseNMT                   # 开启 Native Memory Tracking
-XX:NativeMemoryTracking=summary
```

## 7.2 案例 2：容器 OOM 但宿主机内存充足

### 现象

某 K8s 集群中，Node 有 64GB 内存，仅使用了 30GB。但一个 Pod 频繁 OOMKilled。

```bash
$ kubectl describe pod <pod_name>
# Last State: Terminated
#   Reason: OOMKilled
#   Exit Code: 137

$ kubectl top pod <pod_name>
# MEMORY: 1.8Gi / 2Gi limit
```

### 假设

1. 内存限制设置过低
2. cache 占用大量配额
3. init 进程内存累积
4. cgroup v1 cache 不受控制

### 证据收集

```bash
# 1. 查看 cgroup 内存统计
$ cat /sys/fs/cgroup/memory/kubepods/pod<uid>/<container_id>/memory.stat
cache 1073741824        # 1GB cache！
rss 900000000           # 900MB RSS
mapped_file 800000000   # 800MB 是文件映射

# 2. 查看是什么文件在 cache 中
$ cat /proc/<pid>/smaps | grep -B5 "Mapped" | head -40
# 发现大量 /tmp/ 下的临时文件映射

# 3. 查看 memory.max_usage_in_bytes
$ cat /sys/fs/cgroup/memory/kubepods/pod<uid>/<container_id>/memory.max_usage_in_bytes
2147483648  # 确实达到了 2GB 上限

# 4. 宿主机 free 确认
$ free -h
#               total    used    free    shared  buff/cache   available
# Mem:           62Gi    28Gi    2Gi     512Mi     32Gi        33Gi
# 宿主机确实有大量可用内存
```

### 根因

**Page cache 计入 cgroup 限制**。应用处理大量临时文件（日志轮转、临时缓存），产生的 page cache 约 1GB。`memory.limit_in_bytes = 2GB` 但实际 RSS + cache 已经超过限制。

cgroup v1 的 `memory.limit_in_bytes` 计费公式：

$$\text{memory.usage} = \text{RSS} + \text{cache} + \text{swap}$$

### 修复

```yaml
# 方案 1：使用 emptyDir 的 tmpfs 挂载临时目录（不计入 page cache）
volumes:
- name: tmp
  emptyDir:
    medium: Memory
    sizeLimit: 512Mi

# 方案 2：增加内存限制到 3GB
resources:
  limits:
    memory: 3Gi

# 方案 3：迁移到 cgroup v2，使用 memory.high 而非 memory.max
# memory.high = 2GB（节流但不 OOM）
# memory.max = 3GB（硬限制兜底）
```

## 7.3 案例 3：glibc 内存碎片导致 RSS 虚高

### 现象

某 C++ 服务（使用 glibc malloc）长期运行后 RSS 达到 8GB，但 `jemalloc` 的 `jemalloc_stats()` 显示实际分配仅 3GB。重启后 RSS 立刻回落。

### 假设

1. 内存泄漏
2. glibc arena 碎片
3. 未调用 `malloc_trim`

### 证据收集

```bash
# 1. 查看 arena 数量
$ LD_PRELOAD=/usr/lib/libjemalloc.so MALLOC_CONF="stats_print:true" ./app
# 或通过 gdb
$ gdb -p <pid> -batch -ex 'call (void)malloc_stats()'
Arena 0:
system bytes     = 2147483648  # 2GB
in use bytes     = 1073741824  # 1GB（碎片率 50%！）
Arena 1:
system bytes     = 1073741824
in use bytes     = 536870912
Arena 2:
system bytes     = 1610612736
in use bytes     = 805306368
...

# 2. pmap 分析内存映射分布
$ pmap -x <pid> | grep "rw-" | sort -k 3 -n -r | head -20
# 发现大量 64MB 的匿名映射（每个 arena 的 heap）

# 3. 统计碎片率
# 总 system bytes = 8GB, 总 in use bytes = 3GB
# 碎片率 = (8 - 3) / 8 = 62.5%
```

### 根因

**多线程 glibc arena 碎片**。服务有 32 个核心，glibc 自动创建了 `8 × 32 = 256` 个 arena。每个 arena 使用 mmap 创建独立的 heap segment，跨 arena 无法合并空闲内存。加上分配模式不均匀（线程 A 分配线程 B 释放），导致大量内存滞留在各个 arena 中。

### 修复

```bash
# 方案 1：限制 arena 数量
$ export MALLOC_ARENA_MAX=4  # 最多 4 个 arena

# 方案 2：使用 jemalloc 替代 glibc malloc
$ LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so ./app
# jemalloc 的 arena 管理更高效，碎片率显著更低

# 方案 3：定期调用 malloc_trim
# 在服务中添加定时器，每 30 秒调用一次
# scheduler.add_task([](){ malloc_trim(0); }, 30);

# 方案 4：对大块分配使用 mmap（设置阈值）
$ export MALLOC_MMAP_THRESHOLD_=131072  # 128KB 以上用 mmap
```

## 7.4 案例 4：THP 导致的延迟抖动

### 现象

某 Redis 集群节点 P99 延迟偶尔从 1ms 跳到 50ms，与 GC 无关。

```bash
$ redis-cli --latency-history
# 大部分时间 < 1ms，但每隔几秒出现一次 20~50ms 的毛刺
```

### 假设

1. 网络抖动
2. 慢查询
3. THP compaction 导致
4. NUMA 跨节点访问

### 证据收集

```bash
# 1. 检查 THP 状态
$ cat /sys/kernel/mm/transparent_hugepage/enabled
[always] madvise never    # always！问题可能在这里

# 2. 查看 compaction 统计
$ grep compact /proc/vmstat
compact_stall 12345       # 直接压缩次数，每秒都在增长

# 3. 使用 perf 追踪延迟来源
$ perf record -e 'sched:sched_switch' -g -p <redis_pid> -- sleep 10
$ perf report
# 发现大量 khugepaged 相关的延迟

# 4. 查看 khugepaged 活动
$ grep -i huge /proc/vmstat
thp_fault_alloc 567890
thp_collapse_alloc 12345     # khugepaged 合并页数

# 5. 对比 THP 关闭后的延迟
$ echo never > /sys/kernel/mm/transparent_hugepage/enabled
# P99 延迟恢复稳定 < 1ms
```

### 根因

**THP 的 khugepaged 后台合并操作导致延迟抖动**。`always` 模式下，内核会积极地将小页合并为 2MB 大页。合并过程中需要锁住页面、迁移数据，这会导致正在访问这些页面的 Redis 请求被阻塞。

### 修复

```bash
# 方案 1：设置 THP 为 madvise（推荐）
$ echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# 方案 2：如果 Redis 已经使用 madvise(MADV_HUGEPAGE) 标记了大内存区域
# 那么保持 madvise 模式，Redis 只在需要时使用 THP

# 方案 3：永久配置（在 sysctl 或 systemd 中）
$ cat >> /etc/sysfs.conf <<EOF
kernel/mm/transparent_hugepage/enabled = madvise
kernel/mm/transparent_hugepage/defrag = defer+madvise
EOF

# 方案 4：对于需要大页的场景，使用显式大页
$ echo 512 > /proc/sys/vm/nr_hugepages  # 预分配 512 个 2MB 大页
# Redis 配置：use-large-pages yes
```

## 7.5 案例 5：NUMA 跨节点访问导致性能下降

### 现象

某数据库服务在新服务器上部署后，QPS 比旧服务器低 30%，但 CPU 和内存规格完全相同。

```bash
# 新旧服务器对比
# 旧：单路 CPU，1 个 NUMA 节点，64GB
# 新：双路 CPU，2 个 NUMA 节点，64GB × 2 = 128GB
```

### 假设

1. NUMA 跨节点内存访问
2. 内存带宽瓶颈
3. CPU 频率差异
4. 磁盘 I/O 差异

### 证据收集

```bash
# 1. 查看 NUMA 拓扑
$ numactl --hardware
available: 2 nodes (0-1)
node 0 size: 65536 MB
node 1 size: 65536 MB

# 2. 查看进程的 NUMA 内存分布
$ cat /proc/<pid>/numa_maps | awk '{print $2}' | sort | uniq -c
# anon=1234 dirty=1234 N0=400 N1=834
# 大量内存分配在 Node 1，但进程的线程主要运行在 Node 0 的 CPU 上

# 3. 使用 numastat 查看 NUMA 命中率
$ numastat -p <pid>
# Per-node process memory usage (in MBs)
#                  Node 0    Node 1    Total
# ---------------  ------    ------    -----
# Heap               800      3200      4000    ← 大部分堆内存在 Node 1
# Stack              200         0       200
# Private            400       100       500

# 4. perf 统计 NUMA miss
$ perf stat -e node-loads,node-load-misses -p <pid> sleep 10
# node-load-misses: 45,678,901    ← NUMA miss 很高！
# 30% 的内存访问是跨节点的
```

### 根因

**NUMA 跨节点内存访问**。双路服务器默认的 NUMA 策略是 `default`（在当前 CPU 所在节点分配），但数据库启动时大量初始化内存在 Node 1 上分配（因为启动线程恰好调度到了 Node 1 的 CPU），后续运行时线程主要在 Node 0 的 CPU 上，导致大量跨节点访问。

### 修复

```bash
# 方案 1：使用 numactl 绑定到单节点
$ numactl --cpunodebind=0 --membind=0 ./db_server

# 方案 2：使用 interleave 策略（适合大内存数据库）
$ numactl --interleave=all ./db_server

# 方案 3：K8s 中使用 Topology Manager
# kubelet 配置
--topology-manager-policy=single-numa-node

# 方案 4：使用 systemd 绑定
$ cat > /etc/systemd/system/db.service.d/numa.conf <<EOF
[Service]
ExecStart=
ExecStart=/usr/bin/numactl --cpunodebind=0 --membind=0 /opt/db/bin/server
EOF

# 修复后验证
$ numastat -p <pid>
# Per-node process memory usage (in MBs)
#                  Node 0    Node 1    Total
# Heap              4000         0      4000    ← 全部在 Node 0
# node-load-misses 降低到 < 1%
# QPS 恢复正常
```

**本章要点：**

- **JVM RSS 虚高** 先查 NMT（DirectByteBuffer、Thread Stack、Metaspace），再查 glibc arena 碎片
- **容器 OOM 但宿主机内存充足** 多半是 page cache 计入 cgroup 限制，检查 `memory.stat` 中的 `cache`
- **glibc 碎片率超过 50%** 是常见现象，限制 `MALLOC_ARENA_MAX` 或切换 jemalloc 是标准解决方案
- **THP `always` 模式是数据库杀手**，所有数据库都应该使用 `madvise` 或 `never`
- **双路服务器必须关注 NUMA**，`numactl --cpunodebind --membind` 是最简单有效的修复

---

# 第 8 章：内存优化最佳实践

## 8.1 应用层优化：减少分配、对象池、内存映射

### 8.1.1 减少不必要的内存分配

```c
// 优化前：循环内反复分配
for (int i = 0; i < 1000000; i++) {
    char* buf = malloc(4096);
    process(buf);
    free(buf);
}

// 优化后：预分配，循环复用
char* buf = malloc(4096);
for (int i = 0; i < 1000000; i++) {
    process(buf);
}
free(buf);
```

```go
// Go 中使用 sync.Pool 减少 GC 压力
var bufferPool = sync.Pool{
    New: func() interface{} {
        return make([]byte, 0, 4096)
    },
}

func processRequest(data []byte) {
    buf := bufferPool.Get().([]byte)
    buf = buf[:0]  // 重置长度，保留容量
    defer bufferPool.Put(buf)

    buf = append(buf, data...)
    // 使用 buf 处理请求
}
```

### 8.1.2 内存映射优化大文件处理

```c
// 使用 mmap 处理大文件，避免一次性读入内存
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>

int fd = open("large_file.dat", O_RDONLY);
struct stat st;
fstat(fd, &st);

void* addr = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
// 直接通过指针访问文件内容，操作系统负责按需加载页面
// 避免了 read() 需要的内核缓冲区拷贝

munmap(addr, st.st_size);
close(fd);
```

### 8.1.3 对象池模式

```java
// Java 中使用对象池减少 GC 压力（Netty 的 ByteBuf 池化示例）
ByteBufAllocator allocator = PooledByteBufAllocator.DEFAULT;
ByteBuf buf = allocator.buffer(1024);
try {
    // 使用 buf
} finally {
    buf.release();  // 归还到池中，不是真正的 free
}
```

## 8.2 运行时优化：JVM GC 调优、Go GOGC

### 8.2.1 JVM GC 调优

```bash
# 1. 选择合适的 GC
# 延迟敏感型服务 → ZGC 或 Shenandoah
java -XX:+UseZGC -Xmx4g -Xms4g -jar app.jar

# 吞吐量优先 → G1GC（JDK 9+ 默认）
java -XX:+UseG1GC -Xmx4g -Xms4g \
     -XX:MaxGCPauseMillis=200 \
     -XX:G1HeapRegionSize=16m \
     -jar app.jar

# 2. 避免 GC 和内存问题的 JVM 参数
java -Xmx4g -Xms4g                        # 堆大小固定，避免动态扩缩
     -XX:MaxMetaspaceSize=512m             # 限制 Metaspace
     -XX:MaxDirectMemorySize=512m          # 限制 DirectMemory
     -XX:+UseNMT                           # 开启 NMT
     -XX:NativeMemoryTracking=summary      # NMT 摘要模式
     -XX:+HeapDumpOnOutOfMemoryError       # OOM 时自动 dump
     -XX:HeapDumpPath=/var/log/app/        # dump 路径
     -jar app.jar

# 3. JVM 内存估算公式
# 总内存 ≈ Heap + Metaspace + ThreadStack × 线程数 + CodeCache + DirectMemory
# 例：4GB Heap + 256MB Meta + 1MB × 500线程 + 240MB Code + 512MB Direct ≈ 5.5GB
```

### 8.2.2 Go 运行时调优

```bash
# 1. GOGC 控制 GC 频率
$ export GOGC=200       # 堆增长 200% 才触发 GC（默认 100%）
                        # 减少 GC 频率，但增加内存使用

# 2. Go 1.19+ 软内存限制（推荐使用）
$ export GOMEMLIMIT=4GiB   # 设置 4GB 软限制
$ export GOGC=off          # 配合 GOMEMLIMIT 使用，禁用百分比触发
                           # Go 运行时会自动在接近限制时加速 GC

# 3. 查看 GC 日志
$ GODEBUG=gctrace=1 ./app
# gc 1 @0.012s 2%: 0.044+1.2+0.017 ms clock, 0.35+0.23/1.3/1.5+0.14 ms cpu,
#   4->6->2 MB, 5 MB goal, 8 P

# 4. 内存分析
import _ "net/http/pprof"
go http.ListenAndServe(":6060", nil)

# 获取 heap profile
$ go tool pprof http://localhost:6060/debug/pprof/heap
```

### 8.2.3 Python 运行时优化

```python
# 1. 使用 sys.getsizeof 识别大对象
import sys
data = [i for i in range(1000000)]
print(sys.getsizeof(data))  # 8MB+

# 2. 使用生成器替代列表（惰性计算）
# 优化前：一次性创建完整列表
data = [process(x) for x in range(10000000)]

# 优化后：使用生成器按需计算
data = (process(x) for x in range(10000000))

# 3. 使用 numpy 数组替代 Python list（内存效率 10~50 倍）
import numpy as np
arr = np.zeros(1000000, dtype=np.int32)  # 4MB
# vs
lst = [0] * 1000000                       # ~36MB

# 4. 使用 tracemalloc 定位内存热点
import tracemalloc
tracemalloc.start()
# ... 业务代码 ...
snapshot = tracemalloc.take_snapshot()
top_stats = snapshot.statistics('lineno')
for stat in top_stats[:10]:
    print(stat)
```

## 8.3 内核参数优化：vm.swappiness、THP、hugepages

### 8.3.1 关键内核参数

```bash
# 1. vm.swappiness：控制 swap 倾向（0~200，默认 60）
# 0：尽可能不使用 swap（但不完全禁用）
# 10：数据库/延迟敏感服务推荐值
# 60：默认值
# 100：积极使用 swap
$ sysctl vm.swappiness=10

# 2. vm.overcommit_memory：内存过量分配策略
# 0（默认）：启发式过量分配
# 1：总是允许（某些数据库需要）
# 2：严格限制（不允许超过 swap + ratio% × RAM）
$ sysctl vm.overcommit_memory=0

# 3. vm.overcommit_ratio：overcommit_memory=2 时的百分比
$ sysctl vm.overcommit_ratio=80

# 4. vm.min_free_kbytes：保留的最低空闲内存
# 影响 watermark 水位线，增大可减少 direct reclaim
$ sysctl vm.min_free_kbytes=262144  # 256MB

# 5. THP 配置
$ echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
$ echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# 6. NUMA balancing
$ sysctl kernel.numa_balancing=1  # 自动 NUMA 页迁移
```

### 8.3.2 场景化配置模板

```bash
# ========== 数据库服务器（Redis/MySQL/PostgreSQL） ==========
vm.swappiness = 1
vm.overcommit_memory = 0
vm.min_free_kbytes = 262144
# THP: never（Redis/MySQL）或 madvise
echo never > /sys/kernel/mm/transparent_hugepage/enabled
# 大页（可选，需要显式配置）
echo 1024 > /proc/sys/vm/nr_hugepages

# ========== Web 应用服务器 ==========
vm.swappiness = 10
vm.overcommit_memory = 0
vm.min_free_kbytes = 131072
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# ========== 容器节点 ==========
vm.swappiness = 10
vm.overcommit_memory = 0
vm.min_free_kbytes = 524288  # 512MB，为 kswapd 留足余量
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# 持久化配置
$ cat >> /etc/sysctl.d/99-memory.conf <<EOF
vm.swappiness = 10
vm.overcommit_memory = 0
vm.min_free_kbytes = 262144
vm.zone_reclaim_mode = 0  # NUMA 系统禁用 zone reclaim
EOF
$ sysctl -p /etc/sysctl.d/99-memory.conf
```

## 8.4 容器环境优化：cgroup 配置、内存限制策略

### 8.4.1 K8s Pod 内存配置最佳实践

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: memory-optimized
spec:
  containers:
  - name: app
    image: myapp:latest
    resources:
      requests:
        memory: "1Gi"     # requests: 调度依据，应接近实际使用量
      limits:
        memory: "2Gi"     # limits: OOM 阈值，应留 30~50% 余量
    # 不要把 limits 和 requests 设为相同值！
    # 相同值意味着 QoS Guaranteed，但减少了灵活性
```

### 8.4.2 cgroup v2 最佳实践

```bash
# 启用 cgroup v2（K8s kubelet 配置）
# /var/lib/kubelet/config.yaml
cgroupDriver: systemd  # systemd 默认使用 cgroup v2

# cgroup v2 分层内存控制示例
# memory.low: 最低保障（不会被回收）
echo "512M" > /sys/fs/cgroup/myapp/memory.low

# memory.high: 高压阈值（触发节流和回收，但不 OOM）
echo "1536M" > /sys/fs/cgroup/myapp/memory.high

# memory.max: 硬限制（超过则 OOM）
echo "2G" > /sys/fs/cgroup/myapp/memory.max

# memory.swap.max: 限制 swap 使用量
echo "512M" > /sys/fs/cgroup/myapp/memory.swap.max
# 或完全禁用 swap
echo "0" > /sys/fs/cgroup/myapp/memory.swap.max
```

### 8.4.3 内存限制值的选择策略

```text
确定容器内存限制的方法论

1. 收集基线数据
   ┌──────────────────────────────────────────────┐
   │  运行 24~72 小时                              │
   │  记录 memory.peak（cgroup v2）               │
   │  记录 memory.max_usage_in_bytes（cgroup v1）  │
   └──────────────────────────────────────────────┘

2. 计算限制值
   ┌──────────────────────────────────────────────┐
   │  limits = peak × 1.3 ~ 1.5                   │
   │  requests = limits × 0.6 ~ 0.7               │
   │                                               │
   │  例：peak = 1.2GB                             │
   │  → limits = 1.6GB ~ 1.8GB                     │
   │  → requests = 1.0GB ~ 1.2GB                   │
   └──────────────────────────────────────────────┘

3. 验证与调整
   ┌──────────────────────────────────────────────┐
   │  监控 OOM 事件：kubectl get events            │
   │  监控 PSI：memory.pressure                    │
   │  定期检查 memory.peak 变化趋势                │
   └──────────────────────────────────────────────┘
```

**本章要点：**

- **应用层**：对象池（Go sync.Pool、Netty ByteBuf 池）和 mmap 是减少分配的两大利器
- **JVM**：总内存估算 = Heap + Meta + Thread×N + Code + Direct + glibc 碎片，`-Xms` 应等于 `-Xmx`
- **Go 1.19+**：`GOMEMLIMIT` + `GOGC=off` 是最推荐的组合
- **内核参数**：数据库用 `swappiness=1`，THP 设 `never` 或 `madvise`
- **容器限制**：`limits = peak × 1.3~1.5`，`requests = limits × 0.6~0.7`，不要相等

---

# 第 9 章：总结与深入学习

## 9.1 内存分配完整链路总结

让我们用一张完整的图总结从 `malloc` 到物理内存的全链路：

```text
完整内存分配链路（一次 malloc(4096) 的旅程）

应用层
  │  malloc(4096)
  ↓
glibc ptmalloc2
  │  1. 查找 fastbins[4096 对应的 index]
  │  2. 查找 small bins / unsorted bin
  │  3. 都没有 → 从 top chunk 分配
  │  4. top chunk 不够 → brk() 或 mmap()
  ↓
系统调用
  │  brk(heap_end + 4096)    或    mmap(NULL, 4096, ...)
  ↓
内核 VMA 管理
  │  1. 找到合适的 VMA（vm_area_struct）
  │  2. 创建新的 VMA 或扩展现有 VMA
  │  3. 更新进程的页表（标记为 present）
  ↓
返回用户态
  │  此时只分配了虚拟地址空间，没有物理页
  ↓
进程首次访问该地址
  │  CPU 查页表 → PTE 不存在 → 触发 page fault
  ↓
内核处理 page fault
  │  handle_mm_fault()
  │  → do_anonymous_page()
  │  → alloc_page() 从伙伴系统分配物理页
  │  → 更新 PTE 映射
  ↓
NUMA 节点选择
  │  根据分配策略选择物理页所在 NUMA 节点
  │  default: 当前 CPU 所在节点
  ↓
物理页分配
  │  伙伴系统 → slab 分配器 → 物理页框
  │  更新 memcg 计费（cgroup）
  ↓
TLB 更新
  │  CPU TLB 缓存新的虚拟→物理映射
  ↓
用户态访问完成
  │  数据写入物理页
  └───────────────────────────────
```

## 9.2 从应用开发者到内存专家

掌握 Linux 内存管理需要跨越多个层次的知识。以下是推荐的学习路径：

```text
学习路径图

Level 1: 应用开发者
├── 理解语言运行时的内存模型
├── 掌握基本的内存分析工具（top, ps, free）
└── 能诊断简单的内存泄漏

Level 2: 资深开发者
├── 理解 glibc malloc / jemalloc 的内部机制
├── 掌握 /proc/[pid]/smaps、pmap 等精细工具
├── 能进行 JVM NMT / Go pprof / Python tracemalloc 分析
└── 理解 RSS、PSS、USS 的区别和适用场景

Level 3: 系统工程师
├── 理解内核内存管理（伙伴系统、slab、VMA）
├── 掌握 eBPF 内存追踪
├── 熟练配置 cgroup v1/v2 内存控制器
├── 理解 NUMA 架构和优化策略
└── 能分析 THP、compaction、swap 等内核行为

Level 4: 内核/性能专家
├── 能阅读 mm/ 目录下的内核源码
├── 能编写 BPF 程序进行内存追踪
├── 能分析 perf 数据和 flamegraph
├── 能设计内存分配器（自定义 allocator）
└── 能针对特定场景优化内核参数和分配策略
```

## 9.3 推荐资源

### 书籍

| 书名 | 作者 | 难度 | 说明 |
|------|------|------|------|
| 《深入理解计算机系统》 | Randal E. Bryant | ⭐⭐ | 虚拟内存章节是基础 |
| 《Linux 内核设计与实现》 | Robert Love | ⭐⭐⭐ | 内存管理章节 |
| 《Understanding the Linux Kernel》 | Bovet & Cesati | ⭐⭐⭐⭐ | 内核内存管理权威参考 |
| 《Systems Performance》 | Brendan Gregg | ⭐⭐⭐ | 性能分析方法论 |
| 《JVM 实战》 | Benjamin J. Evans | ⭐⭐⭐ | JVM 内存和 GC |

### 在线资源

- **Linux 内核源码**：https://elixir.bootlin.com/linux/latest/source/mm/ — 在线阅读 `mm/` 目录下所有源码
- **Brendan Gregg 的性能工具页面**：https://www.brendangregg.com/linuxperf.html
- **BPF Performance Tools**：https://www.brendangregg.com/bpf-performance-tools-book.html
- **glibc malloc 文档**：https://sourceware.org/glibc/wiki/MallocInternals
- **Go 内存模型**：https://tip.golang.org/doc/gc-guide
- **OpenJDK NMT 文档**：https://docs.oracle.com/en/java/javase/17/vm/native-memory-mapping.html

### 实践工具

| 工具 | 用途 | 安装方式 |
|------|------|---------|
| `bcc-tools` | eBPF 内存追踪 | `apt install bpfcc-tools` |
| `perf` | 性能计数器 | `apt install linux-tools-common` |
| `valgrind` | 内存错误检测 | `apt install valgrind` |
| `heaptrack` | 堆内存追踪 | `apt install heaptrack` |
| `jemalloc` | 高性能分配器 | `apt install libjemalloc-dev` |

**本章要点：**

- **内存分配是跨越六个层次的完整链路**：应用 → 运行时 → C 库 → 系统调用 → 内核 → 硬件
- **每个层次都有独立的优化空间**，不能只关注某一层
- **从 RSS 虚高的排查到 NUMA 优化**，需要系统性地掌握各层知识
- **eBPF 是生产环境内存分析的终极武器**，低开销且灵活性极高
- **持续学习内核源码 `mm/` 目录**是成为内存专家的必经之路
