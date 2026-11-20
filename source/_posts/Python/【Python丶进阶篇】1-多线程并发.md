# Python 多线程并发

并发编程用于让程序在同一时间段内处理多个任务。Python 中常见并发模型包括多线程、多进程、协程和异步 I/O。选择哪种模型，取决于任务是 I/O 密集型还是 CPU 密集型。

## 并发与并行

并发和并行经常被混用，但含义不同：

| 概念 | 说明 | 例子 |
|:---|:---|:---|
| 并发 | 多个任务交替推进，不一定同时执行 | 单核 CPU 切换处理多个请求 |
| 并行 | 多个任务真正同时执行 | 多核 CPU 同时计算多个任务 |

Python 程序常见任务类型：

- I/O 密集型：网络请求、文件读写、数据库访问，适合线程或异步 I/O。
- CPU 密集型：加密、压缩、图像处理、复杂计算，适合多进程或原生扩展。

## GIL 基础

CPython 解释器中存在 GIL，也就是全局解释器锁。它保证同一时刻只有一个线程执行 Python 字节码。

GIL 的影响：

- 多线程不能显著提升纯 Python CPU 密集型计算性能。
- 多线程仍然适合 I/O 密集型任务，因为线程等待 I/O 时会释放 GIL。
- CPU 密集型任务更适合使用 `multiprocessing` 或将计算下沉到 C 扩展、NumPy 等库。

## threading 基础

`threading` 是 Python 标准库中的线程模块。

```python
import threading
import time


def worker(name):
    for i in range(3):
        print(f"{name}: {i}")
        time.sleep(1)

thread = threading.Thread(target=worker, args=("task",))
thread.start()
thread.join()

print("done")
```

`start()` 用于启动线程，`join()` 用于等待线程结束。

## 多线程执行多个任务

```python
import threading
import time


def download(url):
    print(f"start {url}")
    time.sleep(1)
    print(f"finish {url}")

urls = ["url1", "url2", "url3"]
threads = []

for url in urls:
    thread = threading.Thread(target=download, args=(url,))
    thread.start()
    threads.append(thread)

for thread in threads:
    thread.join()

print("all finished")
```

这种写法适合少量任务。大量任务建议使用线程池。

## 线程池

线程池可以复用线程，避免频繁创建和销毁线程。

```python
from concurrent.futures import ThreadPoolExecutor, as_completed
import time


def fetch(url):
    time.sleep(1)
    return f"result from {url}"

urls = ["url1", "url2", "url3"]

with ThreadPoolExecutor(max_workers=5) as executor:
    futures = [executor.submit(fetch, url) for url in urls]

    for future in as_completed(futures):
        print(future.result())
```

线程池适合网络请求、接口聚合、文件处理等 I/O 密集型场景。

## 线程安全

多个线程同时修改共享数据，可能产生竞态条件。

```python
import threading

counter = 0
lock = threading.Lock()


def add():
    global counter
    for _ in range(10000):
        with lock:
            counter += 1

threads = [threading.Thread(target=add) for _ in range(5)]

for thread in threads:
    thread.start()

for thread in threads:
    thread.join()

print(counter)
```

`Lock` 可以保证同一时刻只有一个线程进入临界区。

## 常见同步原语

| 原语 | 作用 | 典型场景 |
|:---|:---|:---|
| `Lock` | 互斥锁 | 保护共享变量 |
| `RLock` | 可重入锁 | 同一线程重复获取锁 |
| `Semaphore` | 信号量 | 限制并发数量 |
| `Event` | 事件通知 | 一个线程通知其他线程 |
| `Condition` | 条件变量 | 复杂等待与唤醒 |
| `Queue` | 线程安全队列 | 生产者消费者模型 |

## 生产者消费者模型

`queue.Queue` 是线程安全队列，常用于任务分发。

```python
import queue
import threading
import time

task_queue = queue.Queue()


def producer():
    for i in range(5):
        task_queue.put(i)
        print(f"produce {i}")
    task_queue.put(None)


def consumer():
    while True:
        item = task_queue.get()
        if item is None:
            break
        print(f"consume {item}")
        time.sleep(0.5)
        task_queue.task_done()

threading.Thread(target=producer).start()
threading.Thread(target=consumer).start()
```

实际项目中，如果有多个消费者，需要为每个消费者放入结束信号，或者使用其他停止机制。

## 多进程

多进程可以绕过 GIL，适合 CPU 密集型任务。

```python
from multiprocessing import Pool


def calc(n):
    return n * n

if __name__ == "__main__":
    with Pool(4) as pool:
        results = pool.map(calc, range(10))
    print(results)
```

在 Windows 平台使用多进程时，必须将启动逻辑放在 `if __name__ == "__main__":` 下。

## asyncio 协程

`asyncio` 适合高并发 I/O 场景，例如大量网络连接、异步接口请求和 WebSocket。

```python
import asyncio


async def fetch(name):
    print(f"start {name}")
    await asyncio.sleep(1)
    print(f"finish {name}")
    return name


async def main():
    tasks = [fetch("a"), fetch("b"), fetch("c")]
    results = await asyncio.gather(*tasks)
    print(results)


asyncio.run(main())
```

协程不是线程，它依赖事件循环调度。协程中遇到 `await` 时会让出控制权，让其他协程继续执行。

## concurrent.futures 统一接口

`concurrent.futures` 提供了线程池和进程池的统一接口。

```python
from concurrent.futures import ProcessPoolExecutor


def calc(n):
    return n * n

if __name__ == "__main__":
    with ProcessPoolExecutor(max_workers=4) as executor:
        for result in executor.map(calc, range(10)):
            print(result)
```

- `ThreadPoolExecutor`：适合 I/O 密集型任务。
- `ProcessPoolExecutor`：适合 CPU 密集型任务。

## 超时、取消和异常处理

并发任务要处理异常，避免单个任务失败影响整体流程。

```python
from concurrent.futures import ThreadPoolExecutor, TimeoutError
import time


def task():
    time.sleep(2)
    return "ok"

with ThreadPoolExecutor(max_workers=1) as executor:
    future = executor.submit(task)
    try:
        print(future.result(timeout=1))
    except TimeoutError:
        print("task timeout")
```

线程中的异常不会自动在主线程抛出，只有调用 `future.result()` 时才会重新抛出。

## 并发模型选择

| 场景 | 推荐模型 |
|:---|:---|
| 多个 HTTP 请求、数据库查询、文件读写 | 多线程 / 异步 I/O |
| 大量长连接、WebSocket、异步 Web 框架 | `asyncio` |
| CPU 密集型计算 | 多进程 |
| 简单后台任务 | 线程池 |
| 分布式耗时任务 | Celery / 消息队列 |

## 常见问题

### 线程越多越好吗

不是。线程过多会增加上下文切换、内存占用和调度成本。线程池大小应结合 I/O 等待时间、服务资源和下游承载能力配置。

### 加锁会不会影响性能

会。锁保护共享状态，但也会降低并发度。优先减少共享状态，使用队列传递数据，必要时再加锁。

### asyncio 是否一定比线程快

不一定。异步 I/O 的优势在大量 I/O 等待和长连接场景。如果代码中大量使用阻塞函数，异步程序也会被阻塞。

## 实践建议

- I/O 密集型任务优先考虑线程池或异步 I/O。
- CPU 密集型任务优先考虑多进程。
- 尽量避免多个线程直接修改共享数据。
- 必须设置超时，避免任务永久等待。
- 使用 `Queue` 解耦生产者和消费者。
- 在 Windows 多进程程序中保留 `if __name__ == "__main__":`。
- 并发调用外部服务时要控制并发量，避免压垮下游系统。

## 小结

Python 并发编程的关键是根据任务类型选择模型。多线程适合 I/O 密集型任务，多进程适合 CPU 密集型任务，`asyncio` 适合大量异步 I/O 和长连接场景。写并发程序时，要重点关注线程安全、超时、异常处理、资源释放和下游限流。