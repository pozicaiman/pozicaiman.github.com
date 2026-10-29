---
title: Linux 内核内存调度算法体系：从物理地址、虚拟地址到分配与迁移
date: 2026-10-29 14:00:00
categories: [操作系统]
tags: [Linux, 内核, 内存, 调度器, 性能优化, SRE]
---

> 姊妹篇《Linux 内核内存设计与管理体系》讲的是物理内存的一生。本篇聚焦其中**内存调度算法**这一层：任务如何获得内存分配、页面如何在节点间迁移、内存使用的优先级与权重如何影响分配与回收。
>
> 口径说明：全文以 Linux 5.10 / 5.15 / 6.6 LTS 为基准，涉及版本差异处逐条标注；所有机制描述以内核源码路径为准，不做经验性断言。

---

# 第 1 章：内存调度算法

## 1.1 任务内存分配

<!-- TODO: 展开任务内存分配机制——per-CPU pages、zone 水位、伙伴系统与 SLUB 的分配路径 -->

## 1.2 任务内存迁移

<!-- TODO: 展开页面迁移机制——NUMA  balancing、migration entries、compaction 整理 -->

## 1.3 任务内存优先级

<!-- TODO: 展开内存优先级体系——watermark 分级、memory.low/high/max、mglru 代际 -->

## 1.4 任务内存权重

<!-- TODO: 展开内存权重机制——memcg swappiness、proportional reclaim、psi 反馈 -->

# 第 2 章：内存物理地址和虚拟地址关系

## 2.1 物理地址

<!-- TODO: 展开物理地址——SPARSEMEM 内存模型、memblock、物理页 frame 描述 -->

## 2.2 虚拟地址

<!-- TODO: 展开虚拟地址——4 级/5 级页表、内核地址空间布局、direct map 与 vmalloc -->

# 第 3 章：内存物理地址设计与管理

## 3.1 物理地址设计

### 3.1.1 物理地址空间

<!-- TODO: 展开物理地址空间——Node/Zone 层级、DMA/DMA32/NORMAL/MOVABLE 分区 -->

### 3.1.2 物理地址映射

<!-- TODO: 展开物理地址映射——direct mapping 线性映射、memmap 与 vmemmap -->

### 3.1.3 物理地址管理

<!-- TODO: 展开物理地址管理——page 结构体、pageblock、buddy 空闲链表 -->

## 3.2 物理地址管理

<!-- TODO: 展开物理地址管理实践——碎片治理、CMA、hugepage 预留与运行时分配 -->

# 第 4 章：内存虚拟地址设计与管理

## 4.1 虚拟地址设计

### 4.1.1 虚拟地址空间

<!-- TODO: 展开虚拟地址空间——用户态/内核态划分、mmap 区域、vsyscall 段 -->

### 4.1.2 虚拟地址映射

<!-- TODO: 展开虚拟地址映射——页表逐级翻译、TLB 与 PCID、缺页异常建立映射 -->

### 4.1.3 虚拟地址管理

<!-- TODO: 展开虚拟地址管理——mm_struct 与 VMA 组织、mmap_lock、kfence/kasan 影子地址 -->

## 4.2 虚拟地址管理

<!-- TODO: 展开虚拟地址管理实践——地址空间布局随机化、swap 与页表回收、khugepaged -->
