---
title: Python 网络编程
date: 2026-11-20 10:10:00
categories: [Python]
tags: [Python, Python基础, 网络编程, Socket, HTTP]
---

# Python 网络编程

Python 网络编程主要用于编写客户端、服务端、接口调用、长连接通信和网络自动化工具。常见层次包括 TCP/IP、UDP、HTTP、WebSocket，以及基于这些协议构建的 RPC、消息推送和微服务通信。

## tcp/ip 协议

TCP/IP 是互联网通信的基础协议族。日常开发中最常接触的是 IP、TCP、UDP 和应用层协议。

| 层次 | 常见协议 | 说明 |
|:---|:---|:---|
| 网络层 | IP | 负责主机寻址和路由 |
| 传输层 | TCP / UDP | 负责端到端传输 |
| 应用层 | HTTP / WebSocket / DNS | 面向具体业务场景 |

### TCP 与 UDP 的区别

| 协议 | 特点 | 适用场景 |
|:---|:---|:---|
| TCP | 面向连接、可靠传输、有序、开销较高 | Web 服务、文件传输、数据库连接 |
| UDP | 无连接、不保证可靠、延迟低、开销小 | DNS、音视频、游戏、监控上报 |

TCP 通过三次握手建立连接，通过确认、重传和顺序控制保证数据可靠送达。UDP 不建立连接，发送方直接发送数据包，因此更轻量，但需要业务层自行处理丢包、乱序等问题。

## Socket 基础

`socket` 是网络编程的基础接口，Python 标准库提供了 `socket` 模块。

### TCP 服务端

```python
import socket

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.bind(("127.0.0.1", 9000))
server.listen(5)

print("server started")

while True:
    conn, addr = server.accept()
    print(f"client connected: {addr}")

    data = conn.recv(1024)
    if data:
        print(data.decode("utf-8"))
        conn.sendall("hello client".encode("utf-8"))

    conn.close()
```

### TCP 客户端

```python
import socket

client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
client.connect(("127.0.0.1", 9000))
client.sendall("hello server".encode("utf-8"))

response = client.recv(1024)
print(response.decode("utf-8"))

client.close()
```

### 使用 with 管理连接

```python
import socket

with socket.create_connection(("127.0.0.1", 9000), timeout=5) as client:
    client.sendall(b"ping")
    print(client.recv(1024))
```

使用 `with` 可以确保连接在结束时自动关闭。

## UDP 编程

UDP 不需要建立连接，发送和接收都围绕数据报进行。

### UDP 服务端

```python
import socket

server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
server.bind(("127.0.0.1", 9001))

while True:
    data, addr = server.recvfrom(1024)
    print(addr, data.decode("utf-8"))
    server.sendto(b"ok", addr)
```

### UDP 客户端

```python
import socket

client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
client.sendto(b"hello", ("127.0.0.1", 9001))

data, addr = client.recvfrom(1024)
print(data.decode("utf-8"))
```

UDP 常用于对实时性要求高、允许少量丢包的场景。

## HTTP 编程

HTTP 是最常见的应用层协议。Python 中可以用标准库 `urllib`，实际项目中更常用第三方库 `requests`。

### 使用 urllib 发送 GET 请求

```python
from urllib.request import urlopen

with urlopen("https://example.com", timeout=10) as response:
    body = response.read().decode("utf-8")
    print(response.status)
    print(body[:100])
```

### 使用 requests 调用接口

```python
import requests

response = requests.get("https://api.github.com", timeout=10)
response.raise_for_status()

print(response.json())
```

POST JSON 数据：

```python
import requests

payload = {"name": "Tom", "age": 18}
response = requests.post("https://httpbin.org/post", json=payload, timeout=10)
response.raise_for_status()

print(response.json())
```

### 常见 HTTP 状态码

| 状态码 | 含义 |
|:---|:---|
| `200` | 请求成功 |
| `201` | 创建成功 |
| `301` / `302` | 重定向 |
| `400` | 请求参数错误 |
| `401` | 未认证 |
| `403` | 无权限 |
| `404` | 资源不存在 |
| `500` | 服务端错误 |
| `503` | 服务不可用 |

## websocket 协议

WebSocket 是一种基于 TCP 的全双工通信协议。与 HTTP 请求响应模型不同，WebSocket 建立连接后，客户端和服务端都可以主动发送消息。

### 适用场景

- 即时聊天。
- 实时通知。
- 在线协同编辑。
- 实时行情、监控面板。
- 游戏和互动应用。

### WebSocket 与 HTTP 的区别

| 项目 | HTTP | WebSocket |
|:---|:---|:---|
| 通信模式 | 请求 / 响应 | 全双工双向通信 |
| 连接特点 | 短连接或连接复用 | 长连接 |
| 服务端主动推送 | 不天然支持 | 天然支持 |
| 适合场景 | API、网页资源 | 实时消息、推送 |

### WebSocket 客户端示例

下面示例使用 `websockets` 库。

```python
import asyncio
import websockets

async def main():
    async with websockets.connect("ws://localhost:8765") as ws:
        await ws.send("hello")
        response = await ws.recv()
        print(response)

asyncio.run(main())
```

### WebSocket 服务端示例

```python
import asyncio
import websockets

async def handler(websocket):
    async for message in websocket:
        await websocket.send(f"echo: {message}")

async def main():
    async with websockets.serve(handler, "localhost", 8765):
        await asyncio.Future()

asyncio.run(main())
```

## 超时、重试与异常处理

网络请求必须设置超时，否则程序可能长时间卡住。

```python
import requests

try:
    response = requests.get("https://example.com", timeout=5)
    response.raise_for_status()
except requests.Timeout:
    print("request timeout")
except requests.HTTPError as exc:
    print(f"http error: {exc}")
except requests.RequestException as exc:
    print(f"request failed: {exc}")
```

重试时应控制次数和间隔，避免请求风暴。

```python
import time
import requests

for attempt in range(3):
    try:
        response = requests.get("https://example.com", timeout=5)
        response.raise_for_status()
        break
    except requests.RequestException:
        if attempt == 2:
            raise
        time.sleep(2 ** attempt)
```

## 并发网络请求

网络请求属于 I/O 密集型任务，适合使用线程池或异步 I/O。

### 线程池示例

```python
from concurrent.futures import ThreadPoolExecutor
import requests

urls = [
    "https://example.com",
    "https://www.python.org",
]

def fetch(url):
    response = requests.get(url, timeout=10)
    return url, response.status_code

with ThreadPoolExecutor(max_workers=5) as executor:
    for url, status_code in executor.map(fetch, urls):
        print(url, status_code)
```

### asyncio 思路

异步 I/O 适合大量并发连接，但需要使用支持异步的库，例如 `aiohttp`、`websockets`。

```python
import asyncio

async def task(name):
    await asyncio.sleep(1)
    print(name)

asyncio.run(task("demo"))
```

## 网络调试工具

常用排查工具：

| 工具 | 作用 |
|:---|:---|
| `ping` | 检查网络连通性 |
| `telnet` / `nc` | 检查端口是否可连接 |
| `curl` | 调试 HTTP 请求 |
| `nslookup` | 查询 DNS 解析 |
| `tracert` / `traceroute` | 排查网络路径 |
| `tcpdump` / Wireshark | 抓包分析 |

示例：

```bash
curl -i https://example.com
```

```bash
ping example.com
```

## 安全建议

- 外部请求必须设置超时。
- 不要信任网络输入，接口入参要校验。
- 生产环境使用 HTTPS，避免明文传输敏感信息。
- 密钥、Token 不要写死在代码中，应放在环境变量或密钥管理系统中。
- 对外部接口调用增加重试、限流、熔断和降级策略。
- 服务端要限制请求体大小，防止资源耗尽。

## 小结

Python 网络编程从 Socket 开始，向上延伸到 HTTP、WebSocket 和各类 RPC 框架。实际项目中，要重点关注超时、异常处理、连接复用、并发模型和安全性。掌握这些基础后，就可以继续学习微服务、异步编程和高性能网络服务开发。