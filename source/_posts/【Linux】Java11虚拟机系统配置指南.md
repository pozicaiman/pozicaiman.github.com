---
title: Java 11 虚拟机系统配置指南：从 JVM 参数到 Linux 内核
date: 2026-09-30 18:00:00
categories: [Java]
tags: [Java, JVM, 性能优化, G1GC, Kubernetes, Linux]
---

# 第 1 章：引言 - 为什么 JVM 配置需要理解 Linux

## 1.1 Java 应用的完整运行链路

当一个 Java 应用被部署到生产环境时，它并不是孤立运行的。从用户发出一个 HTTP 请求到操作系统分配 CPU 时间片，整个链路涉及多个层次的协作：

```text
┌─────────────────────────────────────────────────────────┐
│                    用户请求                               │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│              Java Application (Spring Boot)              │
│         对象分配、业务逻辑、线程调度                        │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                    JDK / HotSpot JVM                     │
│         GC、JIT 编译、线程管理、Native Memory              │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                  glibc / malloc (ptmalloc)               │
│           Arena、TCache、mmap、brk                       │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                    Linux Kernel                          │
│      调度器、内存管理、cgroup、文件系统、网络协议栈          │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                Container / Kubernetes                    │
│           cgroup 限制、资源配额、调度策略                   │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                    Hardware                              │
│           CPU、Memory、Disk、Network                     │
└─────────────────────────────────────────────────────────┘
```

大多数 Java 开发者只关注最上层的应用代码和 JVM 参数，但真正决定生产稳定性的，往往是底层的 Linux 内核参数和容器配置。

## 1.2 JVM 与 Linux 内核的交互

JVM 并非一个黑盒。它是一个直接与操作系统交互的用户空间进程：

- **内存分配**：JVM 的 Heap 通过 `mmap` 从操作系统申请大块连续内存；Native Memory 通过 `malloc`/`mmap` 分配；线程栈通过 `pthread_create` 由内核分配
- **CPU 调度**：Java 线程在 Linux 中映射为 1:1 的 pthread，由内核 CFS 调度器分配时间片
- **IO 操作**：文件读写最终通过系统调用 `read`/`write`/`mmap` 进入内核
- **信号处理**：OOM Killer、`SIGTERM`、`SIGKILL` 等信号直接作用于 JVM 进程
- **资源限制**：cgroup 通过内核接口限制进程的 CPU、内存、IO 等资源

> **关键认知**：JVM 的 `-Xmx` 只是 Java Heap 的上限，不等于进程的实际内存消耗。进程的 RSS（Resident Set Size）可能远超 `-Xmx` 的值。

## 1.3 本文的目标与读者

本文面向以下读者：

- 负责 Java 服务生产部署和运维的 **SRE / DevOps 工程师**
- 需要深入理解 JVM 运行机制的 **Java 后端开发**
- 需要处理容器化 Java 服务资源问题的 **平台工程师**
- 希望系统性掌握 JVM 性能调优的 **技术负责人**

本文不追求面面俱到的 API 文档，而是聚焦于 **从 JVM 参数到 Linux 内核的完整配置链路**，每个知识点都配有生产环境可用的命令、输出示例和分析方法。

**本章要点：**

- **Java 应用的运行链路跨越 Application → JVM → glibc → Kernel → Container → Hardware 多个层次**
- **JVM 与 Linux 内核通过 mmap、pthread、系统调用等机制紧密交互**
- **-Xmx 只控制 Java Heap 上限，不等于进程 RSS**
- **生产问题需要从完整链路进行分析，而非仅关注 JVM 层**

---

# 第 2 章：JVM 内存模型全景

理解 JVM 的内存模型是进行任何性能调优的基础。一个 Java 进程的内存消耗远不止 `-Xmx` 所指定的 Heap 大小。

## 2.1 Java Heap：Young + Old

Java Heap 是 JVM 管理的最大一块内存区域，用于存放所有 Java 对象实例。在 G1 GC 下，Heap 被划分为多个固定大小的 **Region**：

```text
┌─────────────────────────────────────────────────────────────┐
│                      Java Heap (-Xmx)                        │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                  Young Generation                       │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐              │  │
│  │  │  Eden    │  │  Eden    │  │ Survivor │              │  │
│  │  │ Region 1 │  │ Region 2 │  │ Region 1 │              │  │
│  │  └──────────┘  └──────────┘  └──────────┘              │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐              │  │
│  │  │  Eden    │  │  Eden    │  │ Survivor │              │  │
│  │  │ Region 3 │  │ Region 4 │  │ Region 2 │              │  │
│  │  └──────────┘  └──────────┘  └──────────┘              │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                  Old Generation                         │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐              │  │
│  │  │ Old      │  │ Old      │  │ Humongous│              │  │
│  │  │ Region 1 │  │ Region 2 │  │ Region 1 │              │  │
│  │  └──────────┘  └──────────┘  └──────────┘              │  │
│  │  ┌──────────┐  ┌──────────┐                             │  │
│  │  │ Old      │  │ Free     │                             │  │
│  │  │ Region 3 │  │ Region   │                             │  │
│  │  └──────────┘  └──────────┘                             │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Young Generation** 包含 Eden 和 Survivor 区域，新对象在 Eden 中分配。经过 Young GC 存活的对象被复制到 Survivor 区域，达到晋升年龄阈值后进入 Old Generation。

**Old Generation** 存放长期存活的对象。当 Old Region 中对象的占用达到一定比例，G1 会在 Mixed GC 中回收这些 Region。

> **Humongous 对象**：当一个对象的大小超过 Region 大小的 50%，G1 会将其分配到连续的 Humongous Region 中。Humongous 对象的分配和回收代价很高，是 G1 调优中需要重点关注的对象。

## 2.2 Non-Heap：Metaspace + Code Cache

Non-Heap 区域存放 JVM 自身运行所需的元数据，不通过 `-Xmx` 控制：

```text
┌─────────────────────────────────────────────────────────────┐
│                       Non-Heap Memory                        │
│                                                              │
│  ┌─────────────────────────────────────┐                     │
│  │           Metaspace                  │                     │
│  │  ┌───────────────────────────────┐   │                     │
│  │  │  Klass Metadata (类元数据)     │   │                     │
│  │  │  Method Metadata (方法元数据)   │   │                     │
│  │  │  Constant Pool (常量池)        │   │                     │
│  │  │  Annotations (注解)            │   │                     │
│  │  └───────────────────────────────┘   │                     │
│  │  -XX:MetaspaceSize=256m              │                     │
│  │  -XX:MaxMetaspaceSize=512m           │                     │
│  └─────────────────────────────────────┘                     │
│                                                              │
│  ┌─────────────────────────────────────┐                     │
│  │     Compressed Class Space          │                     │
│  │  存放压缩类指针的 Klass 对象         │                     │
│  │  -XX:CompressedClassSpaceSize=1g    │                     │
│  └─────────────────────────────────────┘                     │
│                                                              │
│  ┌─────────────────────────────────────┐                     │
│  │           Code Cache                │                     │
│  │  JIT 编译后的本地代码               │                     │
│  │  -XX:ReservedCodeCacheSize=256m     │                     │
│  └─────────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

**Metaspace** 在 JDK 8+ 替代了 PermGen，使用本地内存（Native Memory）存放类元数据。它的增长主要受加载的类数量影响。Spring Boot 应用因为大量的框架注解扫描和代理类生成，Metaspace 通常在 150-400MB 之间。

**Code Cache** 存放 JIT 编译器生成的本地机器码。当 Code Cache 满时，JIT 会停止编译，导致应用性能下降。

## 2.3 Native Memory：Thread Stack + Direct Buffer + JNI

Native Memory 是 JVM 使用但不受 GC 直接管理的本地内存：

```text
┌─────────────────────────────────────────────────────────────┐
│                    Native Memory                             │
│                                                              │
│  ┌──────────────────────────┐  ┌──────────────────────────┐  │
│  │     Thread Stack         │  │     Direct Buffer        │  │
│  │  每个线程 512KB-1MB      │  │  NIO DirectByteBuffer    │  │
│  │  -Xss512k               │  │  -XX:MaxDirectMemorySize │  │
│  │  200 线程 ≈ 200MB       │  │                          │  │
│  └──────────────────────────┘  └──────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────┐  ┌──────────────────────────┐  │
│  │     JNI Allocations      │  │  GC Native Structures    │  │
│  │  本地库分配的内存         │  │  卡表、RSet、SATB队列    │  │
│  │  (数据库驱动、压缩库等)   │  │  记忆集等                │  │
│  └──────────────────────────┘  └──────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────┐  ┌──────────────────────────┐  │
│  │   JIT Compiler Memory    │  │   JVM Internal           │  │
│  │  C1/C2 编译工作区        │  │  符号表、字符串表等       │  │
│  └──────────────────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Native Memory 中最常被忽视的是 **Thread Stack**。在高并发 Web 应用中，Tomcat 线程池 + 异步线程池 + GC 线程 + JIT 线程的总数可能达到 200-500 个，每个线程默认 1MB 栈空间，仅线程栈就可能消耗 200-500MB。

## 2.4 RSS ≠ Heap ≠ Container Limit

这是生产环境中最容易被误解的概念：

```text
┌──────────────────────────────────────────────────────────────────┐
│                    Container Memory Limit                         │
│                         8 GiB                                     │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                 JVM Process RSS                             │  │
│  │                     5.2 GiB                                 │  │
│  │                                                            │  │
│  │  ┌──────────────────────┐  ┌──────────────────────────┐    │  │
│  │  │   Java Heap          │  │   Non-Heap               │    │  │
│  │  │   (-Xmx4g)           │  │   Metaspace: 200MB       │    │  │
│  │  │   Used: 2.8g         │  │   Code Cache: 120MB      │    │  │
│  │  │   Committed: 3.5g    │  │                          │    │  │
│  │  └──────────────────────┘  └──────────────────────────┘    │  │
│  │                                                            │  │
│  │  ┌──────────────────────┐  ┌──────────────────────────┐    │  │
│  │  │   Thread Stacks      │  │   Direct Buffer          │    │  │
│  │  │   300 threads × 1MB  │  │   512MB                  │    │  │
│  │  │   = 300MB            │  │                          │    │  │
│  │  └──────────────────────┘  └──────────────────────────┘    │  │
│  │                                                            │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │   glibc malloc Arena / TCache / Fragmentation        │  │  │
│  │  │   ~500MB                                              │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  │                                                            │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │   mmap / JNI / JVM Internal / GC Structures          │  │  │
│  │  │   ~300MB                                              │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Available for OS / Page Cache                   │  │
│  │                    2.8 GiB                                   │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

> **核心原则**：Container Memory Limit ≠ JVM RSS ≠ Java Heap Used。三者之间的关系是：Container Limit > RSS > Heap Committed > Heap Used。

**本章要点：**

- **JVM 内存分为 Heap（Young + Old）、Non-Heap（Metaspace + Code Cache）、Native Memory（Thread Stack + Direct Buffer + JNI + glibc）三大类**
- **RSS 是进程实际占用的物理内存，通常远大于 Heap 大小**
- **glibc malloc 的 Arena 和内存碎片可能导致 RSS 大幅超过 JVM 管理的内存**
- **容器内存预算必须为 Heap、Non-Heap、Native Memory、glibc 和安全余量分别预留空间**

---

# 第 3 章：JVM 核心参数详解

## 3.1 Heap 参数：-Xms, -Xmx, -Xmn

| 参数 | 控制什么 | 默认值 | 何时调整 |
|------|---------|--------|---------|
| `-Xms` | Java Heap 初始大小 | 物理内存的 1/64 | 生产环境建议与 `-Xmx` 设为相同值，避免运行时扩容开销 |
| `-Xmx` | Java Heap 最大值 | 物理内存的 1/4 | 根据容器内存预算和对象分配速率确定 |
| `-Xmn` | Young Generation 大小 | Heap 的 1/3 | 当 Young GC 过于频繁时增大；当 Old Gen 不足时减小 |
| `-XX:NewSize` | Young Gen 初始大小 | 同 `-Xmn` | 需要分别设置 Young 初始和最大值时使用 |
| `-XX:MaxNewSize` | Young Gen 最大值 | 同 `-Xmn` | 同上 |
| `-XX:NewRatio` | Old/Young 比例 | 2（即 Old:Young = 2:1） | 不建议在 G1 下使用，G1 自己管理 Region |

```bash
# 生产环境典型配置
java -Xms4g -Xmx4g -Xmn2g -jar app.jar

# 容器环境配置
java -Xms4g -Xmx4g -jar app.jar
```

> **最佳实践**：生产环境中 `-Xms` 和 `-Xmx` 必须设为相同值。JVM 在运行时动态调整 Heap 大小会导致额外的 GC 暂停和内存碎片。在容器环境中，不一致的值还可能触发不必要的 OS 内存申请。

## 3.2 GC 选择：-XX:+UseG1GC, -XX:+UseParallelGC

JDK 11 支持的主要 GC 收集器：

| GC 收集器 | 参数 | 特点 | 适用场景 |
|-----------|------|------|---------|
| **G1 GC** | `-XX:+UseG1GC` | 低延迟、可预测暂停 | 大多数生产服务（JDK 9+ 默认） |
| **Parallel GC** | `-XX:+UseParallelGC` | 高吞吐量、暂停时间长 | 批处理、离线计算 |
| **CMS** | `-XX:+UseConcMarkSweepGC` | 已废弃（JDK 14 移除） | 不推荐在 JDK 11 使用 |
| **Serial GC** | `-XX:+UseSerialGC` | 单线程、简单 | 小内存嵌入式应用 |

```bash
# G1 GC 完整配置
java -XX:+UseG1GC \
     -XX:MaxGCPauseMillis=200 \
     -XX:G1HeapRegionSize=8m \
     -XX:InitiatingHeapOccupancyPercent=45 \
     -XX:MaxTenuringThreshold=15 \
     -jar app.jar

# Parallel GC 配置（高吞吐场景）
java -XX:+UseParallelGC \
     -XX:ParallelGCThreads=8 \
     -XX:MaxGCPauseMillis=500 \
     -jar app.jar
```

> **选择建议**：对于延迟敏感的 Web 服务和微服务，G1 GC 是 JDK 11 的最佳选择。Parallel GC 适用于对吞吐量要求高、对暂停不敏感的批处理任务。

## 3.3 Metaspace 参数

| 参数 | 控制什么 | 默认值 | 何时调整 |
|------|---------|--------|---------|
| `-XX:MetaspaceSize` | Metaspace 扩容触发阈值 | 约 21MB | 大型应用建议设为 256m，减少 Full GC 触发 |
| `-XX:MaxMetaspaceSize` | Metaspace 最大值 | 无限制（受物理内存约束） | 容器环境必须设置，防止无限增长导致 OOMKilled |
| `-XX:CompressedClassSpaceSize` | 压缩类指针空间大小 | 1GB | 通常不需要调整 |
| `-XX:MinMetaspaceFreeRatio` | 触发扩容的最小空闲比例 | 40% | 通常不需要调整 |
| `-XX:MaxMetaspaceFreeRatio` | 触发扩容的最大空闲比例 | 70% | 通常不需要调整 |

```bash
# Spring Boot 应用的 Metaspace 配置
java -XX:MetaspaceSize=256m \
     -XX:MaxMetaspaceSize=512m \
     -XX:CompressedClassSpaceSize=512m \
     -jar app.jar
```

> **注意**：Spring Boot 应用因使用大量反射、代理和注解扫描，Metaspace 使用量通常在 150-400MB。如果不设置 `MaxMetaspaceSize`，在容器环境中 Metaspace 可能持续增长直到触发容器 OOMKilled。

## 3.4 Thread 与 Code Cache 参数

| 参数 | 控制什么 | 默认值 | 何时调整 |
|------|---------|--------|---------|
| `-Xss` | 每个线程的栈大小 | 512KB - 1MB（平台相关） | 当线程数多且 Native Memory 紧张时可减小到 256k-512k |
| `-XX:ReservedCodeCacheSize` | Code Cache 最大值 | 240MB | 当 JIT 日志中出现 "CodeCache is full" 时增大 |
| `-XX:InitialCodeCacheSize` | Code Cache 初始值 | 约 2MB | 通常不需要调整 |
| `-XX:ReservedCodeCacheStart` | Code Cache 起始地址 | 自动 | 通常不需要调整 |

```bash
# 高并发服务线程栈配置
java -Xss512k \
     -XX:ReservedCodeCacheSize=256m \
     -jar app.jar
```

**线程数估算**：

```text
总线程数 = Tomcat 线程池 (200)
         + 异步线程池 (50)
         + Netty EventLoop (CPU 核数 × 2)
         + GC 线程 (与核数相关)
         + JIT 编译线程 (4)
         + JVM 内部线程 (20-30)
         + 定时任务线程 (10-20)

示例: 200 + 50 + 16 + 8 + 4 + 25 + 15 ≈ 318 线程
线程栈内存: 318 × 512KB ≈ 160MB
```

## 3.5 GC 日志参数（JDK 9+ Unified Logging）

JDK 11 使用 Unified Logging 替代了传统的 GC 日志参数：

| 参数 | 作用 | 说明 |
|------|------|------|
| `-Xlog:gc*` | 输出所有 GC 相关日志 | 生产环境必须开启 |
| `-Xlog:gc*:file=gc.log` | GC 日志输出到文件 | 推荐使用文件输出 |
| `-Xlog:gc*:file=gc.log:time,uptime,level,tags` | 带时间戳的 GC 日志 | 推荐格式 |
| `-Xlog:gc*::filecount=10,filesize=50m` | GC 日志轮转 | 生产环境必须配置 |
| `-Xlog:safepoint` | SafePoint 日志 | 诊断长时间 STW |
| `-Xlog:gc+heap=debug` | Heap 变化详情 | 深度调优时使用 |
| `-Xlog:gc+ergo*=trace` | GC 自适应调整日志 | 诊断 G1 参数自动调整 |

```bash
# 生产环境推荐的完整 GC 日志配置
java -Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=10,filesize=50m \
     -Xlog:safepoint:file=/var/log/app/safepoint.log:time,uptime:filecount=5,filesize=10m \
     -jar app.jar
```

GC 日志示例输出：

```text
[2026-09-30T10:15:23.456+0800][12.345s][info][gc] GC(5) Pause Young (Normal) (G1 Evacuation Pause) 
  256M->48M(512M) 12.345ms
[2026-09-30T10:15:23.456+0800][12.345s][info][gc,cpu    ] GC(5) User=0.04s Sys=0.01s Real=0.01s
```

> **重要**：JDK 9 之前的 GC 日志参数（`-XX:+PrintGCDetails`、`-Xloggc:` 等）在 JDK 11 中已废弃。必须使用新的 `-Xlog` 语法。

**本章要点：**

- **生产环境 `-Xms` 与 `-Xmx` 必须设为相同值，避免 Heap 动态调整**
- **G1 GC 是 JDK 11 生产服务的默认选择，Parallel GC 适合批处理**
- **Metaspace 必须设置 `MaxMetaspaceSize` 限制容器环境中的无限增长**
- **线程栈大小和数量直接影响 Native Memory，需要结合线程池配置估算**
- **GC 日志必须使用 JDK 9+ Unified Logging 格式，并配置日志轮转**

---

# 第 4 章：G1 GC 深度解析与调优

## 4.1 G1 架构：Region、Young、Old、Humongous

G1 GC 的核心设计思想是将 Heap 划分为大小相等的 **Region**，每个 Region 可以动态地充当 Eden、Survivor、Old 或 Humongous 角色：

```text
┌─────────────────────────────────────────────────────────────────┐
│                    G1 Heap (16GB)                                │
│                                                                  │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐      │
│  │ E  │ │ E  │ │ E  │ │ S  │ │ S  │ │ O  │ │ O  │ │ F  │      │
│  │    │ │    │ │    │ │ 0  │ │ 1  │ │    │ │    │ │    │      │
│  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘      │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐      │
│  │ O  │ │ O  │ │ E  │ │ E  │ │ H  │ │ H  │ │ O  │ │ F  │      │
│  │    │ │    │ │    │ │    │ │    │ │    │ │    │ │    │      │
│  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘      │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐      │
│  │ O  │ │ F  │ │ F  │ │ O  │ │ E  │ │ E  │ │ S  │ │ O  │      │
│  │    │ │    │ │    │ │    │ │    │ │    │ │ 0  │ │    │      │
│  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘      │
│                                                                  │
│  E = Eden    S = Survivor    O = Old    H = Humongous    F = Free │
│  每个 Region 默认 1-32MB，通过 -XX:G1HeapRegionSize 设置         │
└─────────────────────────────────────────────────────────────────┘
```

**Region 大小选择**：

```bash
-XX:G1HeapRegionSize=8m    # 8MB Region，适合 4-8GB Heap
-XX:G1HeapRegionSize=16m   # 16MB Region，适合 8-16GB Heap
-XX:G1HeapRegionSize=32m   # 32MB Region，适合 16GB+ Heap
```

Region 大小必须是 2 的幂，范围从 1MB 到 32MB。Region 越大，RSet 和 GC 管理开销越小，但单次 GC 的 Region 回收粒度越粗。

## 4.2 Young GC 与 Mixed GC

G1 的两种主要 GC 模式：

**Young GC（Evacuation Pause）**：

```text
触发条件：Eden Region 耗尽

执行过程：
1. STW（Stop The World）
2. 扫描 GC Root
3. 复制 Eden + Survivor 中的存活对象到新的 Survivor Region
4. 达到晋升阈值的对象复制到 Old Region
5. 清空 Eden 和原来的 Survivor Region

日志示例：
[info][gc] GC(12) Pause Young (Normal) (G1 Evacuation Pause)
  512M->128M(2048M) 15.234ms
```

**Mixed GC**：

```text
触发条件：Old Region 占比超过 IHOP（InitiatingHeapOccupancyPercent）

执行过程：
1. 并发标记（Concurrent Marking）确定 Old Region 中的存活对象
2. STW，同时回收 Young Region + 部分垃圾比例高的 Old Region
3. 选择回收价值最高的 Old Region（垃圾最多的优先）

日志示例：
[info][gc] GC(25) Pause Young (Concurrent Start) (G1 Evacuation Pause)
  1024M->256M(2048M) 18.567ms
[info][gc] GC(26) Pause Remark  1024M->256M(2048M) 2.345ms
[info][gc] GC(27) Pause Mixed (G1 Evacuation Pause)
  1024M->384M(2048M) 22.890ms
```

## 4.3 Concurrent Mark 与 Remark

并发标记是 G1 回收 Old Region 的前提，它分为多个阶段：

```text
┌──────────────────────────────────────────────────────────────┐
│              G1 Concurrent Marking Phases                      │
│                                                               │
│  ┌─────────────┐                                              │
│  │ Initial Mark │ ← 借 Young GC 的 STW 完成（几乎无额外开销） │
│  └──────┬──────┘                                              │
│         ↓                                                     │
│  ┌─────────────┐                                              │
│  │ Root Region  │ ← 并发，扫描 Survivor 到 Old 的引用         │
│  │   Scanning   │                                              │
│  └──────┬──────┘                                              │
│         ↓                                                     │
│  ┌─────────────┐                                              │
│  │ Concurrent   │ ← 并发，遍历整个 Heap 标记存活对象           │
│  │    Mark      │    （应用线程同时运行，对象引用可能变化）     │
│  └──────┬──────┘                                              │
│         ↓                                                     │
│  ┌─────────────┐                                              │
│  │  Remark      │ ← STW，处理并发标记期间的引用变化            │
│  │              │    （SATB buffer 处理）                       │
│  └──────┬──────┘                                              │
│         ↓                                                     │
│  ┌─────────────┐                                              │
│  │ Concurrent   │ ← 并发，清理完全没有存活对象的 Region        │
│  │   Cleanup    │                                              │
│  └─────────────┘                                              │
└──────────────────────────────────────────────────────────────┘
```

**Remark 阶段**是并发标记中唯一的 STW 阶段，它的暂停时间取决于并发标记期间引用变化的数量。如果应用的对象分配和引用变更非常频繁，Remark 时间可能显著增加。

## 4.4 关键调优参数

| 参数 | 默认值 | 作用 | 调优建议 |
|------|--------|------|---------|
| `-XX:MaxGCPauseMillis` | 200ms | 目标最大 GC 暂停时间 | 延迟敏感设为 50-100ms；批处理设为 200-500ms |
| `-XX:G1HeapRegionSize` | 自动计算 | Region 大小 | 大对象多时增大；Heap 较大时适当增大 |
| `-XX:InitiatingHeapOccupancyPercent` (IHOP) | 45% | 触发并发标记的 Heap 占用比例 | Old Gen 增长快时降低到 30-35%；增长慢时可提高到 50-60% |
| `-XX:G1NewSizePercent` | 5% | Young Gen 最小比例 | Young GC 过于频繁时增大到 20-30% |
| `-XX:G1MaxNewSizePercent` | 60% | Young Gen 最大比例 | 需要更多 Old Gen 时减小到 40-50% |
| `-XX:MaxTenuringThreshold` | 15 | 对象晋升到 Old Gen 的年龄阈值 | Survivor 溢出时降低；对象过早晋升时增大 |
| `-XX:G1MixedGCCountTarget` | 8 | Mixed GC 的目标次数 | Old Gen 回收压力大时减小到 4-6 |
| `-XX:G1HeapWastePercent` | 5% | 允许的 Heap 浪费比例 | Mixed GC 不再回收 Old Region 的阈值 |
| `-XX:G1ReservePercent` | 10% | 保留 Heap 空间比例 | Evacuation 失败时增大到 15-20% |

```bash
# 低延迟 Web 服务调优配置
java -XX:+UseG1GC \
     -XX:MaxGCPauseMillis=100 \
     -XX:G1HeapRegionSize=8m \
     -XX:InitiatingHeapOccupancyPercent=35 \
     -XX:G1NewSizePercent=20 \
     -XX:G1MaxNewSizePercent=50 \
     -XX:MaxTenuringThreshold=12 \
     -XX:G1MixedGCCountTarget=4 \
     -Xms8g -Xmx8g \
     -jar app.jar
```

## 4.5 GC 日志分析

通过 GC 日志可以提取以下关键指标：

```text
# GC 日志关键信息提取
[info][gc] GC(42) Pause Young (Normal) (G1 Evacuation Pause)
  2048M->512M(8192M) 18.234ms

# 解读：
# GC(42)          : 第 42 次 GC
# Pause Young     : Young GC 类型
# 2048M           : GC 前 Heap 使用量
# 512M            : GC 后 Heap 使用量
# (8192M)         : Heap 总大小
# 18.234ms        : GC 暂停时间
```

**关键性能指标计算**：

```text
Allocation Rate = (本次 GC 前 Young 使用 - 上次 GC 后 Young 使用) / GC 间隔时间
Promotion Rate  = (本次 GC 后 Old 使用 - 上次 GC 后 Old 使用) / GC 间隔时间
GC Overhead     = GC 总时间 / 应用运行总时间 × 100%

健康指标参考：
- Young GC 频率: 5-30 秒/次
- Young GC 暂停: < 30ms
- Mixed GC 暂停: < 100ms
- Allocation Rate: < 500MB/s
- Promotion Rate: < 100MB/s
- GC Overhead: < 5%
```

**本章要点：**

- **G1 将 Heap 划分为等大的 Region，每个 Region 可动态充当 Eden/Survivor/Old/Humongous**
- **Young GC 回收 Eden + Survivor，Mixed GC 同时回收 Young + 部分 Old Region**
- **`-XX:InitiatingHeapOccupancyPercent` 是控制并发标记频率的关键参数**
- **Remark 是并发标记中唯一的 STW 阶段，暂停时间取决于引用变更量**
- **通过 GC 日志计算 Allocation Rate、Promotion Rate 和 GC Overhead 判断 GC 健康状况**

---

# 第 5 章：JVM Native Memory 与 RSS 分析

## 5.1 NMT（Native Memory Tracking）

NMT 是 JDK 自带的 Native 内存跟踪工具，可以精确测量 JVM 管理的各类内存：

```bash
# 启动时开启 NMT
java -XX:NativeMemoryTracking=summary -jar app.jar

# 生产环境使用 detail 级别会有 5-10% 性能开销，建议使用 summary
java -XX:NativeMemoryTracking=detail -jar app.jar

# 查看内存报告
jcmd <pid> VM.native_memory summary
```

**NMT 输出示例**：

```text
                         Reserved        Committed
                     ───────────────   ───────────────
        Java Heap:     8589934592 (8192.0MB) 4294967296 (4096.0MB)
              Class:      83886080 (   80.0MB)    52428800 (   50.0MB)
               Thread:     524288000 (  500.0MB)   524288000 (  500.0MB)
                 Code:     251658240 (  240.0MB)    67108864 (   64.0MB)
                   GC:    1073741824 ( 1024.0MB)   536870912 (  512.0MB)
             Compiler:      16777216 (   16.0MB)    16777216 (   16.0MB)
               Internal:     41943040 (   40.0MB)    41943040 (   40.0MB)
              Symbol:      33554432 (   32.0MB)    33554432 (   32.0MB)
        Native Memory Tracking:      8388608 (    8.0MB)     8388608 (    8.0MB)
        Module:         3145728 (    3.0MB)     3145728 (    3.0MB)
              Unknown:     104857600 (  100.0MB)   104857600 (  100.0MB)

                    Total:    11205206016 (10686.0MB) 5691260928 (5426.0MB)
```

**NMT 各项含义解读**：

| NMT 项 | 含义 | 典型值 | 异常判断 |
|--------|------|--------|---------|
| **Java Heap** | Heap 的保留/提交空间 | ≈ `-Xmx` | Reserved 应等于 `-Xmx` |
| **Class** | Metaspace + Compressed Class Space | 100-400MB | 持续增长可能类加载泄漏 |
| **Thread** | 所有线程栈的总和 | 200-500MB | 线程数 × `-Xss` |
| **Code** | Code Cache | 64-240MB | 接近 `ReservedCodeCacheSize` 需关注 |
| **GC** | GC 相关的 Native 结构 | Heap 的 5-15% | G1 的 RSet 和 SATB 占用 |
| **Compiler** | JIT 编译器工作区 | 10-30MB | 通常稳定 |
| **Internal** | JVM 内部数据结构 | 20-60MB | 通常稳定 |
| **Symbol** | 符号表（类名、方法名等） | 20-50MB | 通常稳定 |
| **Unknown** | 未分类的 Native 分配 | 不定 | 可能包含 JNI、Direct Buffer 等 |

## 5.2 RSS 组成模型

进程的 RSS（Resident Set Size）包含 JVM 管理的内存和 JVM 之外的内存：

```text
Process RSS (来自 /proc/<pid>/status 的 VmRSS)
│
├── JVM Reserved/Committed Memory (NMT 报告)
│   ├── Java Heap
│   ├── Metaspace (Class)
│   ├── Code Cache
│   ├── Thread Stacks
│   ├── GC Structures
│   ├── JIT Compiler
│   └── JVM Internal
│
├── Direct Buffer (java.nio.DirectByteBuffer)
│   └── -XX:MaxDirectMemorySize 控制
│
├── JNI Libraries
│   ├── 数据库驱动 (Oracle, MySQL native)
│   ├── 压缩库 (zlib, lz4)
│   ├── 加密库 (OpenSSL)
│   └── 其他 Native 库
│
├── glibc malloc (ptmalloc)
│   ├── Arena (主线程 + 每个新线程一个)
│   ├── TCache (Thread Cache)
│   ├── mmap 区域
│   └── 内存碎片与 Retention
│
├── mmap 匿名映射
│   └── JVM 内部、JNI 库等
│
└── File-backed mmap
    └── Jar 包、共享库、日志文件等 (部分计入 RSS)
```

查看进程 RSS 详情：

```bash
# 基本 RSS 信息
cat /proc/<pid>/status | grep -E "VmRSS|VmSize|VmPeak"

# 详细内存映射
cat /proc/<pid>/smaps_rollup

# 输出示例
# Rss:             5872640 kB    (约 5.6GB RSS)
# Pss:             5432064 kB    (约 5.2GB PSS)
# Shared_Clean:     440576 kB
# Shared_Dirty:          0 kB
# Private_Clean:    262144 kB
# Private_Dirty:   5169920 kB
```

## 5.3 glibc malloc 与 Arena

glibc 的 ptmalloc2 是 Linux 上默认的内存分配器，它对 Java 进程的 RSS 有重大影响：

```text
┌───────────────────────────────────────────────────────────────┐
│                  glibc ptmalloc2 Architecture                  │
│                                                                │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐               │
│  │ Main Arena  │  │ Thread     │  │ Thread     │  ...          │
│  │ (主线程)    │  │ Arena 1    │  │ Arena 2    │               │
│  │             │  │ (线程1)    │  │ (线程2)    │               │
│  │ ┌─────────┐│  │ ┌─────────┐│  │ ┌─────────┐│               │
│  │ │ Top     ││  │ │ Top     ││  │ │ Top     ││               │
│  │ │ Chunk   ││  │ │ Chunk   ││  │ │ Chunk   ││               │
│  │ └─────────┘│  │ └─────────┘│  │ └─────────┘│               │
│  │ ┌─────────┐│  │ ┌─────────┐│  │ ┌─────────┐│               │
│  │ │ TCache  ││  │ │ TCache  ││  │ │ TCache  ││               │
│  │ └─────────┘│  │ └─────────┘│  │ └─────────┘│               │
│  │ ┌─────────┐│  │ ┌─────────┐│  │ ┌─────────┐│               │
│  │ │ Free    ││  │ │ Free    ││  │ │ Free    ││               │
│  │ │ List    ││  │ │ List    ││  │ │ List    ││               │
│  │ └─────────┘│  │ └─────────┘│  │ └─────────┘│               │
│  └────────────┘  └────────────┘  └────────────┘               │
│                                                                │
│  ← brk 系统调用扩展 →     ← mmap 系统调用分配 →                │
└───────────────────────────────────────────────────────────────┘
```

**Arena 数量限制**：

```bash
# glibc 默认最多创建 8 × CPU 核数个 Arena
# 但 Java 的每个线程可能触发创建新的 Arena

# 查看当前 Arena 数量（通过 mallinfo 或 gdb）
# 实践中，300 线程的 Java 进程可能有 50-200 个 Arena
```

**Arena 的内存回收问题**：

> glibc Arena 中的内存，即使应用调用了 `free()`，也不会立即归还给操作系统。只有 Arena 顶部的空闲内存才会通过 `brk` 收缩归还。中部的碎片化空闲内存会一直保留在进程 RSS 中。

**关键环境变量**：

```bash
# 限制 Arena 最大数量，减少内存碎片
# 建议在容器启动脚本中设置
export MALLOC_ARENA_MAX=4

# 启用内存归还（MADV_DONTNEED）
export MALLOC_TRIM_THRESHOLD_=131072
export MALLOC_MMAP_THRESHOLD_=131072
```

## 5.4 内存碎片与 Retention

内存碎片是导致 RSS 持续高于预期的主要原因之一：

```text
正常情况（无碎片）：
┌─────────┬─────────┬─────────┬─────────┬─────────┐
│ In Use  │ In Use  │ In Use  │ In Use  │  Free   │
└─────────┴─────────┴─────────┴─────────┴─────────┘
                                    ↑
                              可通过 brk 归还

碎片化情况（高碎片）：
┌─────────┬─────────┬─────────┬─────────┬─────────┐
│ In Use  │  Free   │ In Use  │  Free   │  Free   │
└─────────┴─────────┴─────────┴─────────┴─────────┘
     ↑                   ↑
 无法归还              无法归还（被阻塞）

→ RSS 不会下降，即使应用已经释放了大量对象
```

**碎片程度诊断**：

```bash
# 查看进程的内存段分布
pmap -x <pid> | tail -20

# 查看匿名 mmap 段数量和大小
cat /proc/<pid>/maps | grep -c "anon"
cat /proc/<pid>/maps | grep "anon" | awk '{sum += strtonum("0x"$2) - strtonum("0x"$1)} END {print sum/1024/1024 " MB"}'
```

**本章要点：**

- **NMT 是分析 JVM 内存的首选工具，`-XX:NativeMemoryTracking=summary` 在生产环境开销可接受**
- **RSS 包含 JVM 管理的内存 + glibc Arena + JNI + mmap 等 JVM 之外的内存**
- **glibc 的 ptmalloc2 通过 Arena 管理内存，Arena 数量过多会导致内存碎片和 RSS 膨胀**
- **设置 `MALLOC_ARENA_MAX=4` 可以有效控制 Arena 数量和内存碎片**
- **内存碎片化会导致"已释放但 RSS 不降"的现象，需通过 `malloc_trim` 或环境变量调优**

---

# 第 6 章：GC 日志分析与诊断

## 6.1 JDK 11 GC 日志格式

JDK 11 的 Unified Logging GC 日志格式如下：

```text
[2026-09-30T10:15:23.456+0800][12.345s][info ][gc,start    ] GC(5) Pause Young (Normal) (G1 Evacuation Pause)
[2026-09-30T10:15:23.460+0800][12.349s][debug][gc,heap     ] GC(5) Eden regions: 256->0(240)
[2026-09-30T10:15:23.460+0800][12.349s][debug][gc,heap     ] GC(5) Survivor regions: 16->20(30)
[2026-09-30T10:15:23.460+0800][12.349s][debug][gc,heap     ] GC(5) Old regions: 128->130
[2026-09-30T10:15:23.460+0800][12.349s][debug][gc,heap     ] GC(5) Humongous regions: 4->2
[2026-09-30T10:15:23.468+0800][12.357s][info ][gc,phases   ] GC(5)   Evacuation Pause: 12.1ms
[2026-09-30T10:15:23.468+0800][12.357s][debug][gc,phases   ] GC(5)   Ext Root Scanning: 1.2ms
[2026-09-30T10:15:23.468+0800][12.357s][debug][gc,phases   ] GC(5)   Update RS: 0.8ms
[2026-09-30T10:15:23.468+0800][12.357s][debug][gc,phases   ] GC(5)   Scan RS: 1.5ms
[2026-09-30T10:15:23.468+0800][12.357s][debug][gc,phases   ] GC(5)   Code Root Scanning: 0.3ms
[2026-09-30T10:15:23.468+0800][12.357s][debug][gc,phases   ] GC(5)   Object Copy: 7.8ms
[2026-09-30T10:15:23.468+0800][12.357s][debug][gc,phases   ] GC(5)   Termination: 0.4ms
[2026-09-30T10:15:23.468+0800][12.357s][info ][gc          ] GC(5) Pause Young (Normal) (G1 Evacuation Pause) 2048M->512M(8192M) 12.345ms
[2026-09-30T10:15:23.468+0800][12.357s][info ][gc,cpu      ] GC(5) User=0.05s Sys=0.01s Real=0.01s
```

**日志字段解析**：

| 字段 | 含义 |
|------|------|
| `[2026-09-30T10:15:23.456+0800]` | 墙钟时间 |
| `[12.345s]` | JVM 启动后的运行时间 |
| `[info]` | 日志级别 |
| `[gc,start]` | 日志标签（支持多标签） |
| `GC(5)` | 第 5 次 GC 事件 |
| `Pause Young (Normal)` | GC 类型和原因 |
| `2048M->512M(8192M)` | GC 前使用→GC 后使用(总容量) |
| `12.345ms` | GC 暂停时间 |

## 6.2 关键指标：Allocation Rate、Promotion Rate

**Allocation Rate（分配速率）**：

```text
Allocation Rate = (当前 GC 前 Eden 使用 - 上次 GC 后 Eden 使用) / GC 间隔时间

示例：
GC(10): Eden 256M -> 0M, time = 100s
GC(11): Eden 256M -> 0M, time = 103s

Allocation Rate = 256MB / 3s = 85 MB/s
```

**Promotion Rate（晋升速率）**：

```text
Promotion Rate = (本次 GC 后 Old 使用 - 上次 GC 后 Old 使用) / GC 间隔时间

示例：
GC(10): Old 512M -> 512M, time = 100s
GC(11): Old 512M -> 514M, time = 103s

Promotion Rate = 2MB / 3s = 0.67 MB/s
```

**健康指标阈值**：

| 指标 | 正常 | 关注 | 告警 |
|------|------|------|------|
| Allocation Rate | < 200 MB/s | 200-500 MB/s | > 500 MB/s |
| Promotion Rate | < 50 MB/s | 50-100 MB/s | > 100 MB/s |
| Young GC 频率 | > 10s/次 | 5-10s/次 | < 5s/次 |
| Young GC 暂停 | < 20ms | 20-50ms | > 50ms |
| Mixed GC 暂停 | < 50ms | 50-100ms | > 100ms |
| Full GC 频率 | 0 | 偶发 | > 1次/天 |
| GC Overhead | < 2% | 2-5% | > 5% |

## 6.3 Full GC 根因分析

G1 的 Full GC 是单线程的 Serial GC，会导致长时间 STW，是生产环境的重大事故：

```text
Full GC 触发原因分析：

1. Evacuation Failure（晋升失败）
   现象: "to-space exhausted" 或 "to-space overflow"
   原因: GC 时没有足够的空闲 Region 存放存活对象
   根因: -XX:G1ReservePercent 太低、Heap 太小、分配速率太高

2. Humongous Object 分配失败
   现象: Full GC 前出现大量 Humongous 分配
   原因: 没有连续的空闲 Region 供 Humongous 对象使用
   根因: 大对象分配过于频繁、Region 太小

3. Metaspace 耗尽
   现象: "Metadata GC Threshold" 或 "Metadata GC Threshold Soft"
   原因: Metaspace 达到阈值触发 Full GC 进行类卸载
   根因: -XX:MetaspaceSize 太小、类加载泄漏

4. System.gc() 调用
   现象: GC 日志中显示 "System.gc()"
   原因: 代码或第三方库显式调用 System.gc()
   根因: 检查代码、使用 -XX:+DisableExplicitGC 屏蔽
```

**Full GC 日志示例**：

```text
[info][gc] GC(100) Pause Full (G1 Evacuation Pause) 
  7680M->7168M(8192M) 5432.123ms
[info][gc,cpu] GC(100) User=8.12s Sys=0.23s Real=5.43s
```

> **5.4 秒的 Full GC 暂停意味着 5.4 秒的服务完全不可用。** 在高并发场景下，这会导致大量请求超时、连接池耗尽、上游服务熔断。

## 6.4 STW 分析

STW（Stop-The-World）是 GC 暂停的根源。通过 GC 日志定位 STW 瓶颈：

```text
[info][gc,phases] GC(42) Evacuation Pause: 18.2ms
  ├── Ext Root Scanning: 2.1ms      ← 扫描 GC Root（线程栈、寄存器等）
  ├── Update RS: 1.5ms              ← 更新 Remembered Set
  ├── Scan RS: 3.2ms                ← 扫描 Remembered Set（Old→Young 引用）
  ├── Code Root Scanning: 0.5ms     ← 扫描 Code Cache 中的 Root
  ├── Object Copy: 9.8ms            ← 对象复制（最大瓶颈！）
  ├── Termination: 0.8ms            ← 工作线程结束同步
  └── Other: 0.3ms

# Object Copy 是主要的 STW 来源
# 优化方向：减少存活对象数量、增大 Region 大小、减少 Young Gen 大小
```

**Safepoint 分析**：

```bash
# 开启 Safepoint 日志
java -Xlog:safepoint -jar app.jar

# 输出示例
[info][safepoint] Safepoint "G1CollectForAllocation", Time since last: 12345 ms,
  Reaching safepoint: 0.234 ms, At safepoint: 18.567 ms, Total: 18.801 ms

# "Reaching safepoint" 是所有线程到达安全点的时间
# 如果此值异常大（> 100ms），说明有线程长时间不进入安全点
# 常见原因：大方法中的密集循环（无 safepoint poll）、JNI 调用
```

**本章要点：**

- **JDK 11 GC 日志使用 Unified Logging 格式，通过 `-Xlog:gc*` 输出**
- **Allocation Rate 和 Promotion Rate 是判断 GC 健康状况的核心指标**
- **G1 的 Full GC 是单线程的，会导致严重 STW，必须通过调优避免**
- **STW 的主要瓶颈通常是 Object Copy，取决于存活对象的数量和大小**
- **Safepoint 日志可以诊断"线程到达安全点慢"的问题**

---

# 第 7 章：JVM 故障诊断工具链

## 7.1 jcmd：JVM 诊断瑞士军刀

`jcmd` 是 JDK 自带的功能最全面的诊断工具，替代了多个传统的诊断命令：

```bash
# 列出所有 Java 进程
jcmd -l

# 查看 JVM 版本和启动参数
jcmd <pid> VM.version
jcmd <pid> VM.flags
jcmd <pid> VM.command_line
```

**VM.flags 输出示例**：

```text
$ jcmd 12345 VM.flags
12345:
-XX:CICompilerCount=4 -XX:CompressedClassSpaceSize=536870912 
-XX:ConcGCThreads=2 -XX:G1HeapRegionSize=8388608 
-XX:G1NewSizePercent=20 -XX:InitiatingHeapOccupancyPercent=35 
-XX:MaxGCPauseMillis=100 -XX:MaxMetaspaceSize=536870912 
-XX:MaxNewSize=4294967296 -XX:MetaspaceSize=268435456 
-XX:MinHeapDeltaBytes=8388608 -XX:+UseCompressedClassPointers 
-XX:+UseCompressedOops -XX:+UseG1GC
```

**核心诊断命令**：

```bash
# Native Memory 分析（最常用的内存诊断命令）
jcmd <pid> VM.native_memory summary

# Heap 信息
jcmd <pid> GC.heap_info

# 堆中对象统计（类直方图）
jcmd <pid> GC.class_histogram

# 线程 dump
jcmd <pid> Thread.print

# 创建 Heap Dump（生产慎用，会触发 STW）
jcmd <pid> GC.heap_dump /tmp/heapdump.hprof

# 查看类加载统计
jcmd <pid> GC.class_stats

# 强制 GC（不推荐在生产使用）
jcmd <pid> GC.run

# 查看 JVMTI Agent
jcmd <pid> VM.list_plugins
```

**GC.class_histogram 输出示例**：

```text
$ jcmd 12345 GC.class_histogram
 num     #instances         #bytes  class name
   1:       2345678      187654240  [B
   2:        876543      105185160  java.lang.String
   3:        345678       38765432  java.util.HashMap$Node
   4:        234567       28148040  java.lang.reflect.Method
   5:        123456       19752960  com.example.model.UserDTO

# [B = byte[]，通常是字符串内容、序列化数据、网络缓冲区
# 如果某类的实例数持续增长，可能存在内存泄漏
```

## 7.2 jstat：GC 统计

`jstat` 提供实时的 JVM 统计信息：

```bash
# GC 统计（最常用）
jstat -gc <pid> 1000 10    # 每 1 秒采样一次，共 10 次

# GC 使用率（百分比形式）
jstat -gcutil <pid> 1000

# GC 原因
jstat -gccause <pid> 1000

# 类加载统计
jstat -class <pid> 1000

# JIT 编译统计
jstat -compiler <pid> 1000
```

**jstat -gc 输出解读**：

```text
$ jstat -gc 12345 1000 3
 S0C    S1C    S0U    S1U      EC       EU        OC         OU       MC     MU    CCSC   CCSU   YGC     YGCT    FGC    FGCT     GCT
16384.0 16384.0  0.0  8192.0 262144.0 196608.0 4194304.0  2097152.0 245760.0 212992.0 32768.0 28672.0   156    2.345   0      0.000    2.345
16384.0 16384.0  0.0  8192.0 262144.0 229376.0 4194304.0  2097152.0 245760.0 212992.0 32768.0 28672.0   156    2.345   0      0.000    2.345
16384.0 16384.0  0.0  4096.0 262144.0  65536.0 4194304.0  2101248.0 245760.0 212992.0 32768.0 28672.0   157    2.362   0      0.000    2.362

# 字段含义：
# S0C/S1C: Survivor 0/1 容量 (KB)
# S0U/S1U: Survivor 0/1 使用量 (KB)
# EC: Eden 容量    EU: Eden 使用量
# OC: Old 容量     OU: Old 使用量
# MC: Metaspace 容量  MU: Metaspace 使用量
# CCSC: Compressed Class Space 容量  CCSU: 使用量
# YGC: Young GC 次数   YGCT: Young GC 总耗时
# FGC: Full GC 次数     FGCT: Full GC 总耗时
# GCT: GC 总耗时
```

**关键观察点**：

```bash
# Old Gen (OU) 持续增长 → 可能存在对象泄漏或晋升过快
# Full GC (FGC) 次数增加 → 立即排查 Full GC 日志
# YGC 频率过高 → Young Gen 太小或分配速率太高
# GCT/运行时间 > 5% → GC 开销过大
```

## 7.3 jstack：线程分析

```bash
# 获取线程 dump
jstack <pid>

# 包含锁信息
jstack -l <pid>

# 强制 dump（进程无响应时使用）
jstack -F <pid>
```

**线程状态分析**：

```text
# 关注点 1：BLOCKED 线程
"thread-pool-1" #15 daemon prio=5 os_prio=0 tid=0x00007f8b2c009800 
  nid=0x1a2b waiting for monitor entry [0x00007f8b1c0fe000]
   java.lang.Thread.State: BLOCKED (on object monitor)
        at com.example.service.OrderService.process(OrderService.java:42)
        - waiting to lock <0x00000007aab12340> (a java.lang.Object)

# 关注点 2：大量 WAITING/TIMED_WAITING 线程
"http-nio-8080-exec-1" #45 daemon prio=5 os_prio=0 tid=0x00007f8b2c012000
  nid=0x1a3c in Object.wait() [0x00007f8b1b0fd000]
   java.lang.Thread.State: TIMED_WAITING (on object monitor)
        at java.lang.Object.wait(Native Method)
        at org.apache.tomcat.util.threads.ThreadPoolExecutor.takeTask(...)

# 关注点 3：RUNNABLE 但 CPU 高的线程
"pool-3-thread-1" #52 prio=5 os_prio=0 tid=0x00007f8b2c015000
  nid=0x1a4d runnable [0x00007f8b1a0fc000]
   java.lang.Thread.State: RUNNABLE
        at com.example.parser.JSONParser.parse(JSONParser.java:128)
```

**快速线程分析命令**：

```bash
# 统计各状态线程数量
jstack <pid> | grep "java.lang.Thread.State" | sort | uniq -c | sort -rn

# 查找死锁
jstack <pid> | grep -A 5 "Found.*deadlock"

# 查找特定线程
jstack <pid> | grep -B 5 "BLOCKED"
```

## 7.4 jmap：堆分析

```bash
# 堆摘要
jmap -heap <pid>

# 堆中对象统计（与 jcmd GC.class_histogram 相同）
jmap -histo <pid> | head -30

# 仅统计存活对象（会触发 Full GC！）
jmap -histo:live <pid> | head -30

# 创建 Heap Dump
jmap -dump:format=b,file=/tmp/heap.hprof <pid>

# 不触发 Full GC 的 Heap Dump
jmap -dump:format=b,live,file=/tmp/heap.hprof <pid>
```

**jmap -heap 输出示例**：

```text
$ jmap -heap 12345
using thread-local object allocation.
Garbage-First (G1) GC with 4 thread(s)

Heap Configuration:
   MinHeapFreeRatio         = 40
   MaxHeapFreeRatio         = 70
   MaxHeapSize              = 8589934592 (8192.0MB)
   NewSize                  = 134217728 (128.0MB)
   MaxNewSize               = 5152702464 (4914.0MB)
   OldSize                  = 54525952 (52.0MB)
   NewRatio                 = 2
   G1HeapRegionSize         = 8388608 (8.0MB)

Heap Usage:
G1 Heap:
   regions  = 1024
   capacity = 8589934592 (8192.0MB)
   used     = 4294967296 (4096.0MB)
   free     = 4294967296 (4096.0MB)
   50.0% used
```

> **生产注意事项**：`jmap -histo:live` 和 `jmap -dump:live` 都会触发 Full GC，可能导致长时间 STW。建议使用 `jcmd <pid> GC.class_histogram` 替代 `jmap -histo:live`，使用 `jcmd <pid> GC.heap_dump` 替代 `jmap -dump`。

## 7.5 perf：CPU 与系统级分析

`perf` 是 Linux 内核自带的性能分析工具，可以分析 CPU 热点、缓存命中、系统调用等：

```bash
# CPU 采样分析（最常用）
perf top -p <pid>

# 记录 CPU 事件
perf record -p <pid> -g -- sleep 30
perf report

# 分析 Java 热点方法
perf record -p <pid> -g -e cpu-clock -- sleep 30
perf report --stdio

# 分析 Page Fault
perf record -p <pid> -e page-faults -g -- sleep 30

# 分析上下文切换
perf record -p <pid> -e context-switches -g -- sleep 30
```

**perf 与 Java 符号解析**：

```bash
# Java 方法在 perf 中默认显示为 [JIT]，需要生成映射文件
# JDK 11 内置 perf 支持：
java -XX:+PreserveFramePointer -jar app.jar

# 或使用 perf-map-agent
java -XX:+PreserveFramePointer -jar app.jar
# 生成 Java 符号映射
create-java-perf-map.sh <pid>

# 现在 perf 可以看到 Java 方法名
perf top -p <pid>
```

**本章要点：**

- **`jcmd` 是最全面的 JVM 诊断工具，可以替代 jps、jmap、jstack 的大部分功能**
- **`jstat -gc` 可以实时监控 Heap 使用和 GC 行为，是最轻量的线上诊断手段**
- **`jstack` 用于线程分析，重点关注 BLOCKED、WAITING 和 CPU 高的 RUNNABLE 线程**
- **`jmap -dump` 和 `jmap -histo:live` 会触发 Full GC，生产环境优先使用 `jcmd`**
- **`perf` 可以进行系统级 CPU 分析，结合 `-XX:+PreserveFramePointer` 解析 Java 符号**

---

# 第 8 章：Linux 内核参数与 JVM 的交互

## 8.1 vm.swappiness 与 OOM

**swappiness** 控制内核将匿名页交换到 swap 空间的倾向：

```bash
# 查看当前值
cat /proc/sys/vm/swappiness
# 默认值: 60

# 临时设置
sysctl -w vm.swappiness=10

# 永久设置（/etc/sysctl.conf）
echo "vm.swappiness=10" >> /etc/sysctl.conf
sysctl -p
```

| 值 | 行为 | 对 JVM 的影响 |
|----|------|--------------|
| 60（默认） | 积极使用 swap | GC 暂停时间显著增加；Heap 访问触发 Page Fault |
| 10 | 仅在紧急时使用 swap | 较好的平衡；大多数服务器推荐值 |
| 0 | 仅在 OOM 时使用 swap（Kernel 3.5+） | 容器环境推荐值 |
| 1 | 极少使用 swap | 与 0 类似但保留紧急交换能力 |

> **关键问题**：当 JVM 的 Heap 页面被 swap out 后，GC 的 STW 阶段需要扫描这些页面，会触发大量 Page Fault，导致 GC 暂停时间从几十毫秒飙升到几秒甚至几十秒。

**OOM Killer 机制**：

```bash
# 查看 OOM 评分
cat /proc/<pid>/oom_score

# 保护关键进程不被 OOM Kill
echo -1000 > /proc/<pid>/oom_score_adj

# 查看 OOM 事件
dmesg | grep -i "oom"
journalctl -k | grep -i "oom"
```

**OOM Kill 日志示例**：

```text
[Sun Sep 30 10:15:23 2026] Out of memory: Kill process 12345 (java) score 850 or sacrifice child
[Sun Sep 30 10:15:23 2026] Killed process 12345 (java) total-vm:12345678kB, anon-rss:8765432kB, file-rss:234567kB, shmem-rss:0kB
```

## 8.2 THP 与 JVM

**Transparent Huge Pages（THP）** 是 Linux 内核自动将 4KB 小页合并为 2MB 大页的机制：

```bash
# 查看 THP 状态
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# 对 JVM 推荐设置为 madvise 或 never
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

**THP 对 JVM 的负面影响**：

```text
问题: THP 的 defrag（碎片整理）操作
      ↓
内核在合并大页时需要移动内存页
      ↓
触发 mmap_sem 写锁
      ↓
所有访问该内存区域的线程被阻塞
      ↓
GC STW 暂停时间不可预测地增加（可达数秒）
      ↓
应用延迟飙升

另外: THP compaction 会导致 CPU system 时间异常升高
```

| THP 设置 | 对 JVM 影响 |
|----------|------------|
| `always` | **不推荐**。内核积极合并大页，defrag 会导致不可预测的 GC 延迟 |
| `madvise` | **推荐**。仅在应用明确请求时合并大页 |
| `never` | **安全**。完全禁用 THP，避免所有相关问题 |

```bash
# 为 JVM 禁用 THP 的推荐方式
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# 或在启动脚本中禁用 defrag
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

## 8.3 NUMA 与 JVM

在多 CPU 插槽的服务器上，NUMA（Non-Uniform Memory Access）架构会影响内存访问延迟：

```text
┌─────────────────────┐     ┌─────────────────────┐
│      Node 0          │     │      Node 1          │
│  ┌──────┐ ┌──────┐  │     │  ┌──────┐ ┌──────┐  │
│  │ CPU  │ │ CPU  │  │     │  │ CPU  │ │ CPU  │  │
│  │ 0-7  │ │ 8-15 │  │     │  │ 16-  │ │ 24-  │  │
│  └──────┘ └──────┘  │     │  │  23  │ │  31  │  │
│  ┌──────────────┐    │     │  └──────┘ └──────┘  │
│  │   Local      │    │     │  ┌──────────────┐    │
│  │   Memory     │    │     │  │   Local      │    │
│  │   64GB       │    │     │  │   Memory     │    │
│  └──────────────┘    │     │  │   64GB       │    │
└──────────┬──────────┘     │  └──────────────┘    │
           │  QPI/Infinity Fabric  │               │
           └───────────────────┬────────────────────┘
```

```bash
# 查看 NUMA 拓扑
numactl --hardware

# 查看进程的 NUMA 内存分配
numastat -p <pid>

# 使用 numactl 绑定 JVM 到特定 NUMA 节点
numactl --cpunodebind=0 --membind=0 java -Xmx8g -jar app.jar

# 或使用 interleave 模式（在所有节点间分配）
numactl --interleave=all java -Xmx8g -jar app.jar
```

**JVM 的 NUMA 感知**：

```bash
# JVM 自带 NUMA 支持（G1 GC）
java -XX:+UseG1GC -XX:+UseNUMA -Xmx16g -jar app.jar

# -XX:+UseNUMA 让 G1 为每个 NUMA 节点分配独立的 Region
# 改善内存访问局部性，减少跨节点访问延迟
```

> **建议**：在 NUMA 机器上，如果 Heap 小于单个 NUMA 节点的本地内存，使用 `numactl --membind` 绑定到单个节点。如果 Heap 大于单个节点的本地内存，使用 `-XX:+UseNUMA` 或 `numactl --interleave=all`。

## 8.4 文件描述符与 mmap

```bash
# 查看进程的文件描述符数量
ls -la /proc/<pid>/fd | wc -l
cat /proc/<pid>/limits | grep "open files"

# 查看进程的 mmap 映射数量
cat /proc/<pid>/maps | wc -l

# 增加文件描述符限制
ulimit -n 65536

# /etc/security/limits.conf 配置
# java_user  soft  nofile  65536
# java_user  hard  nofile  131072
```

**mmap 与 JVM**：

JVM 使用 mmap 的场景包括：

- **Heap 分配**：`-Xmx` 大小的匿名 mmap 映射
- **Metaspace**：类元数据通过 mmap 分配
- **Code Cache**：JIT 编译的代码通过 mmap 分配
- **Direct Buffer**：NIO DirectByteBuffer 通过 mmap 分配
- **JAR 包加载**：jar 包通过 mmap 映射到进程地址空间
- **线程栈**：pthread 创建时通过 mmap 分配栈空间

```bash
# 查看 mmap 的详细统计
cat /proc/<pid>/status | grep -E "VmPeak|VmSize|VmRSS|VmSwap"

# 查看匿名映射的段大小分布
cat /proc/<pid>/smaps_rollup
```

**本章要点：**

- **`vm.swappiness` 应设为 0-10，避免 JVM Heap 页面被 swap out 导致 GC 延迟飙升**
- **THP 的 defrag 操作会导致不可预测的 GC 延迟，建议设置为 `madvise` 或关闭 defrag**
- **NUMA 机器上应使用 `-XX:+UseNUMA` 或 `numactl` 优化内存访问局部性**
- **文件描述符限制应设为 65536 以上，防止连接数多的服务耗尽 FD**
- **JVM 的 Heap、Metaspace、Code Cache、Direct Buffer 均通过 mmap 分配**

---

# 第 9 章：容器环境下的 JVM 配置

## 9.1 cgroup v1 vs v2 与 JVM

容器化环境中，JVM 通过 cgroup 感知资源限制：

```text
┌───────────────────────────────────────────────────────────────┐
│                    cgroup v1 vs v2                             │
│                                                                │
│  cgroup v1 (传统 Docker):                                      │
│  /sys/fs/cgroup/memory/docker/<container-id>/                  │
│  ├── memory.limit_in_bytes      ← 内存硬限制                  │
│  ├── memory.soft_limit_in_bytes ← 内存软限制                  │
│  ├── memory.usage_in_bytes      ← 当前使用                    │
│  └── memory.oom_control         ← OOM 控制                    │
│                                                                │
│  cgroup v2 (现代 Linux):                                       │
│  /sys/fs/cgroup/<container-id>/                                │
│  ├── memory.max       ← 内存硬限制                            │
│  ├── memory.high      ← 内存高压阈值                          │
│  ├── memory.low       ← 内存保护阈值                          │
│  ├── memory.current   ← 当前使用                              │
│  └── memory.events    ← OOM 事件计数                          │
└───────────────────────────────────────────────────────────────┘
```

**JDK 11 的容器感知**：

JDK 10+ 引入了容器感知特性（JEP 332），JDK 11 默认开启：

```bash
# JDK 11 自动检测容器 CPU 和内存限制
# 通过以下参数控制容器感知行为：

# 禁用容器 CPU 感知（不推荐）
-XX:-UseContainerSupport

# 自动检测的 CPU 数量
Runtime.getRuntime().availableProcessors()

# 自动检测的内存限制
# 会基于 cgroup 限制调整默认 Heap 大小
```

```bash
# 验证 JVM 是否正确感知容器资源
java -XX:+PrintFlagsFinal -version 2>&1 | grep -E "ActiveProcessorCount|MaxHeapSize"
```

## 9.2 CPU throttling 与 JVM

CPU throttling 是容器环境中影响 JVM 性能的最常见问题：

```text
┌───────────────────────────────────────────────────────────────┐
│              CPU Throttling 对 JVM 的影响                      │
│                                                                │
│  容器配置: 2 CPU (cpu.cfs_quota_us = 200000)                  │
│  应用线程: 200 个并发线程                                       │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 时间片窗口 (100ms period)                                 │  │
│  │                                                          │  │
│  │ ├── 100ms ──┤├── 100ms ──┤├── 100ms ──┤                 │  │
│  │ ▓▓▓▓▓▓▓▓▓░░│▓▓▓▓▓▓▓▓▓░░│▓▓▓▓▓▓▓▓▓░░│                  │  │
│  │ ↑ quota     ↑ throttled ↑ throttled                     │  │
│  │ (200ms)     (100ms 限制) (100ms 限制)                    │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│  GC 期间的 CPU 需求: 4-8 核                                    │
│  实际可用: 2 核                                                │
│  → GC 时间被拉长 2-4 倍                                        │
│  → GC 暂停时间从 20ms 增加到 40-80ms                            │
│  → Concurrent Mark 可能跟不上分配速率                           │
│  → 触发 Full GC                                                │
└───────────────────────────────────────────────────────────────┘
```

**查看 CPU throttling**：

```bash
# cgroup v1
cat /sys/fs/cgroup/cpu/docker/<container-id>/cpu.stat
# nr_periods: 12345
# nr_throttled: 678       ← 被限制的周期数
# throttled_time: 12345678  ← 总限制时间 (ns)

# cgroup v2
cat /sys/fs/cgroup/<container-id>/cpu.stat
# usage_usec 12345678
# user_usec 10000000
# system_usec 2345678
# nr_periods 12345
# nr_throttled 678
# throttled_usec 12345678

# 计算 throttling 率
throttle_rate = nr_throttled / nr_periods × 100%
# 如果 > 10% 说明 CPU 限制严重影响应用性能
```

**CPU 配置最佳实践**：

```bash
# GC 并发线程数建议
# Java 11 G1 默认:
#   ConcGCThreads = ParallelGCThreads / 4
#   ParallelGCThreads = 8 + (CPU - 8) * 5/8  (CPU > 8 时)

# 容器中的推荐配置
# CPU limit >= 4 核：使用默认值
# CPU limit = 2 核：手动限制 GC 线程
-XX:ParallelGCThreads=4
-XX:ConcGCThreads=2

# CPU limit = 1 核：
-XX:ParallelGCThreads=2
-XX:ConcGCThreads=1
```

## 9.3 容器内存限制与 JVM 预算

容器中的内存预算模型：

```text
┌─────────────────────────────────────────────────────────────┐
│                  Container Memory Limit                       │
│                       8 GiB                                   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              JVM Process RSS                          │    │
│  │                                                      │    │
│  │  ┌──────────────────────────┐                        │    │
│  │  │ Java Heap (-Xmx)         │                        │    │
│  │  │ 4 GiB                    │                        │    │
│  │  └──────────────────────────┘                        │    │
│  │                                                      │    │
│  │  ┌──────────────────────────┐                        │    │
│  │  │ Metaspace                │                        │    │
│  │  │ 256 MiB                  │                        │    │
│  │  └──────────────────────────┘                        │    │
│  │                                                      │    │
│  │  ┌──────────────────────────┐                        │    │
│  │  │ Code Cache               │                        │    │
│  │  │ 240 MiB                  │                        │    │
│  │  └──────────────────────────┘                        │    │
│  │                                                      │    │
│  │  ┌──────────────────────────┐                        │    │
│  │  │ Thread Stacks            │                        │    │
│  │  │ 300 threads × 512KB      │                        │    │
│  │  │ = 150 MiB                │                        │    │
│  │  └──────────────────────────┘                        │    │
│  │                                                      │    │
│  │  ┌──────────────────────────┐                        │    │
│  │  │ Direct Buffer            │                        │    │
│  │  │ 512 MiB                  │                        │    │
│  │  └──────────────────────────┘                        │    │
│  │                                                      │    │
│  │  ┌──────────────────────────┐                        │    │
│  │  │ GC Structures + JVM      │                        │    │
│  │  │ Native = ~500 MiB        │                        │    │
│  │  └──────────────────────────┘                        │    │
│  │                                                      │    │
│  │  ┌──────────────────────────┐                        │    │
│  │  │ glibc malloc / Arena     │                        │    │
│  │  │ ~400 MiB                 │                        │    │
│  │  └──────────────────────────┘                        │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           Safety Margin: ~1.5 GiB                    │    │
│  │  (OS 开销 + Page Cache + 峰值余量)                   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Total: 4096 + 256 + 240 + 150 + 512 + 500 + 400 + 1546    │
│       = 7700 MiB ≈ 7.5 GiB < 8 GiB ✓                       │
└─────────────────────────────────────────────────────────────┘
```

**内存预算计算公式**：

```text
Container Memory Limit = 
    Heap (-Xmx)
  + Metaspace (-XX:MaxMetaspaceSize)
  + Code Cache (-XX:ReservedCodeCacheSize)
  + Thread Stacks (线程数 × -Xss)
  + Direct Buffer (-XX:MaxDirectMemorySize)
  + GC Native Structures (Heap × 5-15%)
  + JVM Internal (50-100 MB)
  + glibc / malloc (取决于线程数和分配模式)
  + Safety Margin (总量的 15-25%)
```

## 9.4 Kubernetes JVM 配置最佳实践

**完整的 Kubernetes Deployment 配置示例**：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: java-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: java-service
  template:
    metadata:
      labels:
        app: java-service
    spec:
      containers:
      - name: java-service
        image: registry.example.com/java-service:1.0.0
        resources:
          requests:
            cpu: "2"
            memory: "6Gi"
          limits:
            cpu: "4"
            memory: "8Gi"
        env:
        # glibc malloc 调优
        - name: MALLOC_ARENA_MAX
          value: "4"
        # JVM 参数
        - name: JAVA_OPTS
          value: >-
            -server
            -XX:+UseG1GC
            -XX:MaxGCPauseMillis=200
            -XX:G1HeapRegionSize=8m
            -XX:InitiatingHeapOccupancyPercent=35
            -XX:MaxTenuringThreshold=12
            -XX:ParallelGCThreads=4
            -XX:ConcGCThreads=2
            -XX:+UseNUMA
            -XX:+AlwaysPreTouch
            -XX:+UseStringDeduplication
            -XX:NativeMemoryTracking=summary
            -Xms4g
            -Xmx4g
            -XX:MetaspaceSize=256m
            -XX:MaxMetaspaceSize=512m
            -XX:CompressedClassSpaceSize=256m
            -XX:ReservedCodeCacheSize=240m
            -Xss512k
            -XX:MaxDirectMemorySize=512m
            -XX:+HeapDumpOnOutOfMemoryError
            -XX:HeapDumpPath=/var/log/heapdump.hprof
            -XX:+ExitOnOutOfMemoryError
            -Xlog:gc*:file=/var/log/gc.log:time,uptime,level,tags:filecount=10,filesize=50m
            -Xlog:safepoint:file=/var/log/safepoint.log:time,uptime:filecount=5,filesize=10m
        command: ["sh", "-c"]
        args:
        - |
          # 容器内内存检查
          echo "Container Memory Limit: $(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || cat /sys/fs/cgroup/memory.max 2>/dev/null)"
          echo "JAVA_OPTS: $JAVA_OPTS"
          
          exec java $JAVA_OPTS -jar /app/app.jar
        volumeMounts:
        - name: log-volume
          mountPath: /var/log
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          initialDelaySeconds: 60
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /actuator/health/readiness
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 5
      # 设置 Pod 的 QoS
      terminationGracePeriodSeconds: 60
      volumes:
      - name: log-volume
        emptyDir:
          sizeLimit: 2Gi
```

**关键配置说明**：

| 配置项 | 值 | 原因 |
|--------|-----|------|
| `requests.memory` | 6Gi | 确保调度时有足够资源 |
| `limits.memory` | 8Gi | 容器内存硬限制 |
| `-Xmx` | 4g | Heap = Limit × 50% |
| `MaxMetaspaceSize` | 512m | 防止 Metaspace 无限增长 |
| `MaxDirectMemorySize` | 512m | 限制 Direct Buffer |
| `MALLOC_ARENA_MAX` | 4 | 控制 glibc Arena 数量 |
| `HeapDumpOnOutOfMemoryError` | true | OOM 时自动 dump |
| `ExitOnOutOfMemoryError` | true | OOM 时退出，由 K8s 重启 |

**本章要点：**

- **JDK 11 默认开启容器感知，会根据 cgroup 限制自动调整 CPU 数量和 Heap 默认值**
- **CPU throttling 会直接拉长 GC 暂停时间和并发标记时间，throttle rate > 10% 需要优化**
- **容器内存预算必须为 Heap、Non-Heap、Native Memory、glibc 和安全余量分别预留空间**
- **`-XX:+ExitOnOutOfMemoryError` 优于 `-XX:+UseGCOverheadLimit`，让 Kubernetes 自动重启**
- **`MALLOC_ARENA_MAX=4` 是容器化 Java 应用的标准配置**

---

# 第 10 章：企业故障案例分析

## 10.1 案例 1：JVM RSS 持续上涨但 Heap 稳定

**现象**：

某支付服务部署在 Kubernetes 上，容器内存限制 8GB，`-Xmx4g`。监控显示：

- Java Heap 使用量稳定在 2-3GB
- 进程 RSS 从启动时的 5GB 持续增长到 7.5GB
- 3 天后触发容器 OOMKilled

**假设**：

1. ~~Java Heap 泄漏~~（Heap 稳定，排除）
2. Metaspace 泄漏
3. Native Memory 泄漏
4. glibc malloc Arena / 碎片导致的 RSS 膨胀
5. Direct Buffer 泄漏

**证据采集**：

```bash
# 1. NMT 分析
jcmd <pid> VM.native_memory summary
# 结果：Thread 从 300MB 增长到 800MB（线程数从 200 增长到 600）

# 2. 线程数确认
jcmd <pid> Thread.print | grep -c "nid="
# 结果：623 个线程

# 3. /proc 确认
cat /proc/<pid>/status | grep Threads
# 结果: Threads: 623

# 4. smaps 确认匿名映射
cat /proc/<pid>/smaps_rollup
# 结果: Anonymous 从 5GB 增长到 7GB
```

**根因**：

应用使用了 `ScheduledExecutorService` 但未正确关闭。每次定时任务触发时创建新的线程，旧线程因未设置超时而永久存活。600+ 线程 × 1MB 栈空间 + 每个线程一个 glibc Arena = 大量 Native Memory 和碎片。

**修复**：

```java
// 修复前：每次调用创建新线程池
public void scheduleTask() {
    ScheduledExecutorService executor = Executors.newScheduledThreadPool(1);
    executor.scheduleAtFixedRate(this::doWork, 0, 1, TimeUnit.MINUTES);
}

// 修复后：使用共享的线程池
private final ScheduledExecutorService executor = 
    Executors.newScheduledThreadPool(4, new ThreadFactoryBuilder()
        .setNameFormat("scheduled-task-%d")
        .setDaemon(true)
        .build());
```

同时添加线程数监控告警：

```bash
# Prometheus 告警规则
- alert: JavaThreadCountHigh
  expr: jvm_threads_current > 500
  for: 5m
  labels:
    severity: warning
```

**验证**：修复后线程数稳定在 250-300，RSS 稳定在 5.5GB。

## 10.2 案例 2：容器 OOMKilled 但 Heap 使用率低

**现象**：

某电商搜索服务，容器限制 16GB，`-Xmx12g`。运行一段时间后 OOMKilled，但监控显示 Heap 使用率仅 60%。

**假设**：

1. ~~Heap 泄漏~~（Heap 使用率低，排除）
2. Heap + Non-Heap 超过容器限制
3. glibc 碎片
4. Page Cache 占用
5. OOM Killer 杀错进程

**证据采集**：

```bash
# 1. 检查 OOM Kill 日志
dmesg | grep -i oom
# [Tue Sep 30 03:15:23 2026] java invoked oom-killer: gfp_mask=0x280da, order=0

# 2. NMT 分析
jcmd <pid> VM.native_memory summary
# Heap: 12GB (Committed)
# Thread: 800MB (400 threads × 2MB 栈)
# GC: 1.8GB (G1 RSet + SATB)
# Metaspace: 400MB
# Code Cache: 240MB

# 3. RSS 分析
cat /proc/<pid>/status | grep VmRSS
# VmRSS: 15.2GB

# 4. glibc 分析
# 分析匿名 mmap 段数量
cat /proc/<pid>/maps | grep "anon" | wc -l
# 结果：12000+ 段
```

**根因**：

```text
内存预算分析：
  Heap: 12GB
  GC Structures: 1.8GB  (Heap 的 15%，G1 的 RSet 开销)
  Thread Stacks: 800MB  (400 线程 × 2MB)
  Metaspace: 400MB
  Code Cache: 240MB
  Direct Buffer: 512MB
  glibc malloc: 600MB
  JVM Internal: 100MB
  ─────────────────────
  合计: 16.4GB > Container Limit 16GB
```

`-Xmx12g` 加上 GC 结构、线程栈、glibc 等 Native Memory 总计超过 16GB 容器限制。

**修复**：

```bash
# 调整内存预算
-XX:-Xmx8g -XX:-Xmx8g           # Heap 从 12g 降到 8g
-XX:MaxMetaspaceSize=512m         # 限制 Metaspace
-Xss512k                          # 线程栈从 2MB 降到 512KB
-XX:MaxDirectMemorySize=512m      # 限制 Direct Buffer

# Container limits.memory: 16Gi → 保持不变

# 新预算：
# Heap: 8GB
# GC: 800MB
# Thread: 200MB (400 × 512KB)
# Metaspace: 512MB
# Code Cache: 240MB
# Direct: 512MB
# glibc: 400MB
# Internal: 100MB
# Safety: 3.2GB
# 总计: 13.9GB < 16GB ✓
```

**验证**：RSS 稳定在 11-12GB，Heap 使用率稳定在 70-80%，无 OOMKilled。

## 10.3 案例 3：G1 Full GC 导致服务不可用

**现象**：

某社交应用的消息推送服务，G1 GC 配置下，每天凌晨 3 点左右出现 5-10 秒的 STW，导致大量消息推送超时。

**假设**：

1. 定时任务触发大量对象分配
2. 并发标记跟不上分配速率
3. Humongous 对象过多
4. IHOP 设置不当

**证据采集**：

```bash
# 1. GC 日志分析
grep "Full GC" /var/log/gc.log
# [03:15:23] GC(1523) Pause Full (G1 Evacuation Pause) 
#   7680M->7168M(8192M) 5432.123ms
# [03:15:30] GC(1524) Pause Full (G1 Evacuation Pause) 
#   7680M->7024M(8192M) 4567.456ms

# 2. Full GC 前的 Mixed GC 日志
grep -B 10 "Full GC" /var/log/gc.log | grep "Mixed"
# [03:15:20] GC(1521) Pause Mixed 7200M->6800M(8192M) 45.6ms
# [03:15:21] GC(1522) Pause Mixed 7400M->7100M(8192M) 52.3ms

# 3. Humongous 分配分析
grep -c "Humongous" /var/log/gc.log
# 结果：Full GC 前大量 Humongous Region 分配

# 4. 分配速率分析
# GC(1520): 5000M->2000M, time = 03:15:10
# GC(1521): 7200M->6800M, time = 03:15:20
# Allocation Rate = (7200-2000)/10 = 520 MB/s ← 异常高
```

**根因**：

凌晨 3 点的批量任务（消息队列积压消费 + 历史消息清理）触发了大量大对象分配（序列化的消息体超过 Region 的 50%），导致：

1. Humongous Region 需求激增
2. 并发标记完成后 Mixed GC 来不及回收足够的 Old Region
3. Eden 耗尽触发 Evacuation Failure → Full GC

**修复**：

```bash
# 1. 增大 Region 大小，减少 Humongous 对象
-XX:G1HeapRegionSize=16m    # 从 8m 增大到 16m

# 2. 降低 IHOP，更早触发并发标记
-XX:InitiatingHeapOccupancyPercent=30  # 从 45 降到 30

# 3. 增加 Mixed GC 回收 Old Region 的力度
-XX:G1MixedGCCountTarget=4   # 从 8 降到 4
-XX:G1HeapWastePercent=3      # 从 5 降到 3

# 4. 增加保留空间
-XX:G1ReservePercent=15       # 从 10 增到 15

# 5. 应用层优化：消息体序列化改为分片处理
# 单个消息对象大小从 2MB 降到 100KB
```

**验证**：Full GC 消失，Mixed GC 暂停稳定在 30-50ms，凌晨批量任务期间无服务超时。

## 10.4 案例 4：CPU throttling 导致 GC 延迟飙升

**现象**：

某推荐服务部署在 Kubernetes 上，容器 CPU limit 为 2 核。用户反馈白天高峰时段接口 P99 延迟从 100ms 飙升到 500ms-1s。

**假设**：

1. 应用代码瓶颈
2. 数据库查询慢
3. GC 延迟
4. CPU throttling

**证据采集**：

```bash
# 1. CPU throttling 检查
cat /sys/fs/cgroup/cpu/cpu.stat
# nr_periods: 864000
# nr_throttled: 172800   ← 20% 的周期被限制！
# throttled_time: 345600000000  ← 累计限制 345 秒

# 2. GC 日志分析
grep "Pause" /var/log/gc.log | tail -20
# [14:23:45] Pause Young 2048M->512M(4096M) 45.234ms   ← 正常
# [14:24:01] Pause Young 2048M->512M(4096M) 89.567ms   ← 偏高
# [14:24:15] Pause Mixed 3072M->1024M(4096M) 156.789ms ← 异常
# [14:24:15] [gc,cpu] User=0.32s Sys=0.05s Real=0.16s

# Real(0.16s) vs User+Sys(0.37s)
# Real > User+Sys/核数 说明 CPU 时间被限制

# 3. pidstat 确认
pidstat -t -p <pid> 1 5
# CPU 被限制在 200% (2 核)

# 4. GC CPU 开销计算
# GC 总 CPU = 0.32 + 0.05 = 0.37s
# 可用 CPU = 2.0s (2 核 × 1s)
# GC CPU 占比 = 18.5%
```

**根因**：

2 核 CPU 限制下，G1 GC 的并发标记线程（默认 `ConcGCThreads = ParallelGCThreads / 4`）在 2 核机器上只有 1 个并发线程，导致并发标记速度跟不上对象分配速率。加上 CPU throttling（20% 的时间片被限制），GC 暂停和并发标记时间进一步拉长。

**修复**：

```bash
# 方案 1: 增加 CPU limit（推荐）
resources:
  limits:
    cpu: "4"    # 从 2 核增加到 4 核

# 方案 2: 如果无法增加 CPU，优化 GC 配置
-XX:ParallelGCThreads=3
-XX:ConcGCThreads=1
-XX:MaxGCPauseMillis=100        # 降低目标暂停时间
-XX:InitiatingHeapOccupancyPercent=25  # 更早触发并发标记
-XX:G1NewSizePercent=15          # 减小 Young Gen，降低单次 GC 回收量

# 方案 3: 应用层优化
# 减少对象分配速率
# - 对象池化
# - 减少临时对象
# - 使用基本类型替代包装类型
```

**验证**：CPU throttling rate 从 20% 降到 3%，GC 暂停稳定在 15-25ms，P99 延迟恢复到 100ms。

**本章要点：**

- **RSS 持续增长但 Heap 稳定，首先排查线程泄漏和 glibc Arena 膨胀**
- **OOMKilled 但 Heap 使用率低，需要建立完整的内存预算模型计算 RSS 总量**
- **G1 Full GC 通常是 Evacuation Failure，需要从 IHOP、Humongous、分配速率三个维度排查**
- **CPU throttling 会同时影响 GC 暂停时间和并发标记速度，是容器环境最常见的性能杀手**
- **所有故障分析必须遵循：现象→假设→证据→根因→修复→验证 的完整链路**

---

# 第 11 章：JVM 性能优化方法论

## 11.1 基线建立与指标采集

性能优化的第一步是建立可量化的基线：

```text
┌──────────────────────────────────────────────────────────────┐
│                    性能基线指标体系                             │
│                                                               │
│  ┌───────────────────┐  ┌───────────────────┐                │
│  │    应用层指标       │  │    JVM 层指标      │                │
│  │                   │  │                   │                │
│  │ • QPS / TPS       │  │ • Heap 使用率      │                │
│  │ • P50/P99/P999    │  │ • GC 暂停时间      │                │
│  │ • 错误率          │  │ • GC 频率          │                │
│  │ • 超时率          │  │ • Old Gen 使用率   │                │
│  │                   │  │ • Metaspace 使用量  │                │
│  │                   │  │ • 线程数           │                │
│  │                   │  │ • Direct Buffer    │                │
│  └───────────────────┘  └───────────────────┘                │
│                                                               │
│  ┌───────────────────┐  ┌───────────────────┐                │
│  │    系统层指标       │  │    容器层指标      │                │
│  │                   │  │                   │                │
│  │ • CPU User/Sys    │  │ • CPU Throttling  │                │
│  │ • RSS / PSS       │  │ • 内存使用 vs Limit│                │
│  │ • IO Wait         │  │ • 重启次数        │                │
│  │ • Context Switch  │  │ • OOMKilled       │                │
│  │ • Page Fault      │  │                   │                │
│  └───────────────────┘  └───────────────────┘                │
└──────────────────────────────────────────────────────────────┘
```

**基线采集脚本**：

```bash
#!/bin/bash
# baseline_collect.sh - JVM 性能基线采集
PID=$1
DURATION=${2:-60}  # 默认采集 60 秒
OUTPUT_DIR="/tmp/jvm_baseline_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUTPUT_DIR"

echo "=== JVM Baseline Collection ==="
echo "PID: $PID, Duration: ${DURATION}s"

# 1. JVM 基本信息
jcmd $PID VM.flags > "$OUTPUT_DIR/vm_flags.txt" 2>&1
jcmd $PID VM.command_line > "$OUTPUT_DIR/vm_commandline.txt" 2>&1

# 2. NMT
jcmd $PID VM.native_memory summary > "$OUTPUT_DIR/nmt_summary.txt" 2>&1

# 3. GC 信息
jstat -gc $PID 1000 $DURATION > "$OUTPUT_DIR/jstat_gc.txt" 2>&1

# 4. 线程 dump
jstack $PID > "$OUTPUT_DIR/jstack.txt" 2>&1
jcmd $PID Thread.print > "$OUTPUT_DIR/thread_print.txt" 2>&1

# 5. 堆信息
jcmd $PID GC.heap_info > "$OUTPUT_DIR/heap_info.txt" 2>&1
jcmd $PID GC.class_histogram > "$OUTPUT_DIR/class_histogram.txt" 2>&1

# 6. 系统信息
cat /proc/$PID/status > "$OUTPUT_DIR/proc_status.txt" 2>&1
cat /proc/$PID/smaps_rollup > "$OUTPUT_DIR/proc_smaps_rollup.txt" 2>&1

# 7. CPU 使用
pidstat -t -p $PID 1 $DURATION > "$OUTPUT_DIR/pidstat.txt" 2>&1

# 8. 系统级
vmstat 1 $DURATION > "$OUTPUT_DIR/vmstat.txt" 2>&1

echo "Baseline collected at: $OUTPUT_DIR"
```

## 11.2 瓶颈定位：CPU/Memory/IO/GC

```text
┌──────────────────────────────────────────────────────────────┐
│                    瓶颈定位决策树                               │
│                                                               │
│  应用延迟高                                                    │
│  ├── GC 暂停长?                                               │
│  │   ├── Full GC 频繁 → 第 4/6 章分析                          │
│  │   ├── Young GC 过频 → 增大 Young Gen / 降低分配速率          │
│  │   └── Mixed GC 过长 → IHOP / MixedGCCountTarget            │
│  │                                                            │
│  ├── CPU 高?                                                  │
│  │   ├── GC CPU > 5% → GC 调优                                │
│  │   ├── User CPU 高 → 业务代码热点（perf top）                │
│  │   ├── System CPU 高 → 系统调用过多 / 锁竞争                 │
│  │   └── CPU Throttling → 增加 CPU limit / 优化线程数          │
│  │                                                            │
│  ├── 内存问题?                                                │
│  │   ├── RSS 持续增长 → 第 5 章 NMT + glibc 分析               │
│  │   ├── OOMKilled → 第 9 章内存预算计算                       │
│  │   └── Old Gen 堆积 → 对象泄漏排查                          │
│  │                                                            │
│  └── IO 问题?                                                 │
│      ├── 磁盘 IO → 日志写入 / 临时文件                        │
│      └── 网络 IO → 连接池 / 超时 / DNS                        │
└──────────────────────────────────────────────────────────────┘
```

**快速定位命令集**：

```bash
# 第 1 步：快速判断 GC 是否有问题
jstat -gcutil <pid> 1000 5

# 第 2 步：快速判断 CPU 是否有问题
top -Hp <pid> -n 1

# 第 3 步：快速判断内存是否有问题
cat /proc/<pid>/status | grep -E "VmRSS|VmSwap|Threads"

# 第 4 步：快速判断 IO 是否有问题
pidstat -d -p <pid> 1 5

# 第 5 步：快速判断 CPU throttling
cat /sys/fs/cgroup/cpu/cpu.stat 2>/dev/null || cat /sys/fs/cgroup/*/cpu.stat 2>/dev/null
```

## 11.3 优化实验与回归验证

每一次优化都必须是可度量、可回滚的实验：

```text
┌──────────────────────────────────────────────────────────────┐
│                    优化实验流程                                 │
│                                                               │
│  1. 记录基线指标                                               │
│     ↓                                                         │
│  2. 定义优化假设                                               │
│     "降低 IHOP 从 45% 到 30%，预期 Mixed GC 更早开始，          │
│      避免 Old Gen 堆积导致 Full GC"                             │
│     ↓                                                         │
│  3. 确定验证指标                                               │
│     - Full GC 次数: 期望从 1次/天 降到 0                        │
│     - Mixed GC 暂停: 期望 < 50ms                              │
│     - 应用 P99: 期望无回归                                      │
│     ↓                                                         │
│  4. 灰度发布（10% 流量）                                       │
│     ↓                                                         │
│  5. 观察 24-72 小时                                            │
│     ↓                                                         │
│  6. 对比基线 vs 优化后的指标                                    │
│     ↓                                                         │
│  7. 确认 → 全量发布 / 回滚 → 新假设                             │
└──────────────────────────────────────────────────────────────┘
```

**A/B 对比指标**：

| 指标 | 优化前 | 优化后 | 目标 | 结论 |
|------|--------|--------|------|------|
| Full GC 次数/天 | 1 | 0 | 0 | ✅ 达标 |
| Young GC 暂停 (P99) | 25ms | 22ms | < 30ms | ✅ 达标 |
| Mixed GC 暂停 (P99) | 80ms | 45ms | < 50ms | ✅ 达标 |
| 应用 P99 延迟 | 150ms | 120ms | < 150ms | ✅ 达标 |
| CPU 使用率 | 65% | 60% | < 80% | ✅ 达标 |
| RSS | 5.8GB | 5.6GB | < 6GB | ✅ 达标 |

## 11.4 资源预算模型

```text
┌──────────────────────────────────────────────────────────────┐
│              JVM 资源预算模板 (16GB 容器)                       │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐     │
│  │  组件                  │ 预留(MB) │ 计算方式          │     │
│  ├────────────────────────┼──────────┼──────────────────┤     │
│  │  Java Heap             │  8192    │ -Xmx8g           │     │
│  │  Metaspace             │   512    │ MaxMetaspaceSize  │     │
│  │  Compressed Class      │   256    │ CompressedClass.. │     │
│  │  Code Cache            │   240    │ ReservedCode..    │     │
│  │  Thread Stacks         │   200    │ 400 × 512KB      │     │
│  │  Direct Buffer         │   512    │ MaxDirectMemory.. │     │
│  │  GC Native             │   800    │ Heap × 10%       │     │
│  │  JVM Internal          │   100    │ 固定估算          │     │
│  │  glibc malloc          │   400    │ 经验值            │     │
│  │  Safety Margin         │  1788    │ 总量的 11%        │     │
│  ├────────────────────────┼──────────┼──────────────────┤     │
│  │  合计                  │ 13000    │ < 16384 MB       │     │
│  └──────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

**预算计算注意事项**：

1. **GC Native 内存**：G1 GC 的 RSet 和 SATB 通常占 Heap 的 5-15%，取决于引用变更频率
2. **glibc 内存**：与线程数和分配模式相关，可通过 `MALLOC_ARENA_MAX` 控制
3. **Safety Margin**：建议至少 10-25%，高峰期对象分配、类加载等可能导致内存瞬间上涨
4. **Direct Buffer**：Netty、NIO 等框架大量使用，需要根据实际使用量调整

**本章要点：**

- **性能优化必须先建立基线，再进行可度量的实验**
- **瓶颈定位使用分层决策树：GC → CPU → Memory → IO**
- **每次优化必须定义：假设、验证指标、灰度方案、回滚条件**
- **资源预算模型必须为每个组件分别计算，Safety Margin 不低于 10%**
- **优化是持续过程，不是一次性调整**

---

# 第 12 章：总结与配置模板

## 12.1 JVM 配置检查清单

### 基础配置检查

- [ ] `-Xms` 与 `-Xmx` 是否设为相同值？
- [ ] 是否设置了 `-XX:MaxMetaspaceSize`？
- [ ] 是否开启了 GC 日志（`-Xlog:gc*`）？
- [ ] GC 日志是否配置了轮转（`filecount` + `filesize`）？
- [ ] 是否设置了 `-XX:+HeapDumpOnOutOfMemoryError`？
- [ ] 容器内存 Limit 是否 > Heap + Non-Heap + Native + Safety Margin？

### GC 配置检查

- [ ] 是否使用了 G1 GC（`-XX:+UseG1GC`）？
- [ ] `-XX:MaxGCPauseMillis` 是否根据延迟要求设置？
- [ ] `-XX:InitiatingHeapOccupancyPercent` 是否根据 Old Gen 增长速度调整？
- [ ] GC 线程数是否与容器 CPU limit 匹配？

### 容器环境检查

- [ ] `MALLOC_ARENA_MAX` 是否设置为 4？
- [ ] CPU limit 是否 ≥ 2 核？
- [ ] CPU throttling rate 是否 < 10%？
- [ ] 是否设置了 `-XX:+ExitOnOutOfMemoryError`？
- [ ] 是否设置了 `terminationGracePeriodSeconds`？

### 监控检查

- [ ] 是否监控了 Heap / Old Gen 使用率？
- [ ] 是否监控了 GC 暂停时间和频率？
- [ ] 是否监控了 RSS 和容器内存使用率？
- [ ] 是否监控了线程数？
- [ ] 是否监控了 CPU throttling？

## 12.2 不同场景的配置模板

### 模板 1：微服务（低延迟，2-4 核，4GB 容器）

```bash
# 适用场景：Spring Boot 微服务，延迟敏感，QPS 1000-5000
# 容器配置：CPU 2-4 核，Memory 4GB

java -server \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=100 \
  -XX:G1HeapRegionSize=4m \
  -XX:InitiatingHeapOccupancyPercent=35 \
  -XX:G1NewSizePercent=20 \
  -XX:G1MaxNewSizePercent=50 \
  -XX:MaxTenuringThreshold=12 \
  -XX:ParallelGCThreads=3 \
  -XX:ConcGCThreads=1 \
  -Xms2g \
  -Xmx2g \
  -XX:MetaspaceSize=128m \
  -XX:MaxMetaspaceSize=256m \
  -XX:CompressedClassSpaceSize=128m \
  -XX:ReservedCodeCacheSize=128m \
  -Xss512k \
  -XX:MaxDirectMemorySize=128m \
  -XX:+AlwaysPreTouch \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/var/log/heapdump.hprof \
  -XX:+ExitOnOutOfMemoryError \
  -XX:NativeMemoryTracking=summary \
  -Xlog:gc*:file=/var/log/gc.log:time,uptime,level,tags:filecount=10,filesize=50m \
  -Xlog:safepoint:file=/var/log/safepoint.log:time,uptime:filecount=5,filesize=10m \
  -jar app.jar

# 内存预算：
# Heap: 2GB | Metaspace: 256MB | Code Cache: 128MB
# Thread: 100MB (200×512KB) | Direct: 128MB
# GC Native: 200MB | glibc: 200MB | Safety: 788MB
# 总计: 3.8GB < 4GB ✓
```

### 模板 2：中型服务（中等延迟，4-8 核，8GB 容器）

```bash
# 适用场景：业务核心服务，中等延迟要求，QPS 5000-20000
# 容器配置：CPU 4-8 核，Memory 8GB

java -server \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=200 \
  -XX:G1HeapRegionSize=8m \
  -XX:InitiatingHeapOccupancyPercent=40 \
  -XX:G1NewSizePercent=20 \
  -XX:G1MaxNewSizePercent=50 \
  -XX:MaxTenuringThreshold=15 \
  -XX:ParallelGCThreads=4 \
  -XX:ConcGCThreads=2 \
  -XX:+UseNUMA \
  -Xms4g \
  -Xmx4g \
  -XX:MetaspaceSize=256m \
  -XX:MaxMetaspaceSize=512m \
  -XX:CompressedClassSpaceSize=256m \
  -XX:ReservedCodeCacheSize=240m \
  -Xss512k \
  -XX:MaxDirectMemorySize=512m \
  -XX:+AlwaysPreTouch \
  -XX:+UseStringDeduplication \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/var/log/heapdump.hprof \
  -XX:+ExitOnOutOfMemoryError \
  -XX:NativeMemoryTracking=summary \
  -Xlog:gc*:file=/var/log/gc.log:time,uptime,level,tags:filecount=10,filesize=50m \
  -Xlog:safepoint:file=/var/log/safepoint.log:time,uptime:filecount=5,filesize=10m \
  -jar app.jar

# 内存预算：
# Heap: 4GB | Metaspace: 512MB | Code Cache: 240MB
# Thread: 200MB (400×512KB) | Direct: 512MB
# GC Native: 400MB | glibc: 300MB | Safety: 1.4GB
# 总计: 7.5GB < 8GB ✓
```

### 模板 3：大数据/计算服务（高吞吐，8-16 核，16GB 容器）

```bash
# 适用场景：批处理、数据计算、高吞吐服务
# 容器配置：CPU 8-16 核，Memory 16GB

java -server \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=500 \
  -XX:G1HeapRegionSize=16m \
  -XX:InitiatingHeapOccupancyPercent=45 \
  -XX:G1NewSizePercent=15 \
  -XX:G1MaxNewSizePercent=60 \
  -XX:MaxTenuringThreshold=15 \
  -XX:ParallelGCThreads=8 \
  -XX:ConcGCThreads=3 \
  -XX:+UseNUMA \
  -Xms10g \
  -Xmx10g \
  -XX:MetaspaceSize=256m \
  -XX:MaxMetaspaceSize=512m \
  -XX:CompressedClassSpaceSize=512m \
  -XX:ReservedCodeCacheSize=240m \
  -Xss512k \
  -XX:MaxDirectMemorySize=1g \
  -XX:+AlwaysPreTouch \
  -XX:+UseStringDeduplication \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/var/log/heapdump.hprof \
  -XX:+ExitOnOutOfMemoryError \
  -XX:NativeMemoryTracking=summary \
  -Xlog:gc*:file=/var/log/gc.log:time,uptime,level,tags:filecount=10,filesize=100m \
  -Xlog:safepoint:file=/var/log/safepoint.log:time,uptime:filecount=5,filesize=10m \
  -jar app.jar

# 内存预算：
# Heap: 10GB | Metaspace: 512MB | Code Cache: 240MB
# Thread: 250MB (500×512KB) | Direct: 1GB
# GC Native: 1GB | glibc: 500MB | Safety: 2.5GB
# 总计: 16GB ≤ 16GB ✓
```

### 模板 4：Parallel GC 高吞吐服务

```bash
# 适用场景：离线批处理、日志处理、ETL，对暂停不敏感
# 容器配置：CPU 8 核，Memory 16GB

java -server \
  -XX:+UseParallelGC \
  -XX:ParallelGCThreads=8 \
  -XX:MaxGCPauseMillis=500 \
  -XX:GCTimeRatio=99 \
  -Xms12g \
  -Xmx12g \
  -XX:MetaspaceSize=256m \
  -XX:MaxMetaspaceSize=512m \
  -Xss512k \
  -XX:MaxDirectMemorySize=1g \
  -XX:+AlwaysPreTouch \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/var/log/heapdump.hprof \
  -XX:+ExitOnOutOfMemoryError \
  -XX:NativeMemoryTracking=summary \
  -Xlog:gc*:file=/var/log/gc.log:time,uptime,level,tags:filecount=10,filesize=100m \
  -jar app.jar

# 内存预算：
# Heap: 12GB | Metaspace: 512MB | Thread: 200MB
# Direct: 1GB | GC Native: 600MB | glibc: 300MB
# Safety: 1.3GB
# 总计: 16GB ≤ 16GB ✓
```

## 12.3 推荐资源

### 官方文档

- [Oracle JDK 11 Documentation](https://docs.oracle.com/en/java/javase/11/)
- [OpenJDK 11 Release Notes](https://openjdk.org/projects/jdk/11/)
- [JEP 332: Low-Overhead Heap Profiling](https://openjdk.org/jeps/332)

### GC 调优

- [Oracle G1 GC Tuning Guide](https://docs.oracle.com/en/java/javase/11/gctuning/garbage-first-g1-garbage-collector.html)
- [Understanding G1 GC Logs](https://docs.oracle.com/en/java/javase/11/gctuning/garbage-first-garbage-collector-logging.html)

### JVM 内存分析

- [NMT Documentation](https://docs.oracle.com/en/java/javase/11/vm/native-memory-tracking.html)
- [JVM Anatomy Quarks](https://shipilev.net/jvm-anatomy-quarks/) — Aleksey Shipilëv 的 JVM 内部机制系列文章

### Linux 性能分析

- [Brendan Gregg's Linux Performance](https://www.brendangregg.com/linuxperf.html)
- [BPF Performance Tools](http://www.brendangregg.com/bpf-performance-tools-book.html)

### 容器化 Java

- [Java and Containers](https://developers.redhat.com/articles/java-and-containers)
- [Kubernetes Resource Management for Java Applications](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)

---

**全文总结：**

- **JVM 配置不是孤立的参数调整，而是涵盖 Heap、Non-Heap、Native Memory、glibc、Linux Kernel、cgroup 的完整链路**
- **RSS ≠ Heap ≠ Container Limit，生产故障排查必须建立 RSS 组成模型**
- **G1 GC 是 JDK 11 生产服务的首选，关键调优参数包括 IHOP、MaxGCPauseMillis、G1HeapRegionSize**
- **NMT 是 JVM 内存诊断的核心工具，`jcmd` 是最全面的诊断工具**
- **容器环境中 CPU throttling 和内存预算是最常见的问题根源**
- **所有优化必须基于证据，遵循「现象→假设→证据→根因→修复→验证」的完整链路**
- **资源预算模型是容器化 JVM 配置的基础，Safety Margin 不低于总量的 10%**
