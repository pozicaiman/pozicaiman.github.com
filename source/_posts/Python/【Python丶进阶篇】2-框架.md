---
title: Python Web 框架
date: 2026-11-20 10:30:00
categories: [Python]
tags: [Python, Python进阶, Web框架, Flask, Django, FastAPI]
---

# Python Web 框架

Python Web 框架用于快速构建 Web 应用、API 服务、后台管理系统和微服务。常见框架包括 Flask、Django、FastAPI、Tornado 和 Sanic。选择框架时，需要结合项目规模、性能要求、团队经验和生态能力综合判断。

## 框架概览

| 框架 | 类型 | 特点 | 适用场景 |
|:---|:---|:---|:---|
| Flask | 轻量级 WSGI 框架 | 简洁、灵活、扩展丰富 | 小中型 Web、API 服务 |
| Django | 全功能 Web 框架 | ORM、Admin、认证、模板体系完善 | 后台系统、内容管理、业务系统 |
| FastAPI | 现代 ASGI 框架 | 类型提示、自动文档、异步支持 | API 服务、微服务、AI 服务接口 |
| Tornado | 异步网络框架 | 支持长连接和非阻塞 I/O | WebSocket、实时应用 |
| Sanic | 异步 Web 框架 | 高性能、语法接近 Flask | 高并发异步 API |

## WSGI 与 ASGI

Python Web 框架底层通常遵循 WSGI 或 ASGI 协议。

| 协议 | 说明 | 常见框架 |
|:---|:---|:---|
| WSGI | 同步 Web 服务网关接口 | Flask、Django 传统模式 |
| ASGI | 异步服务网关接口，支持 HTTP、WebSocket | FastAPI、Starlette、Django Channels |

WSGI 适合同步请求响应模型。ASGI 支持异步处理和长连接，更适合 WebSocket、流式响应和高并发 I/O 场景。

## Flask

Flask 是轻量级 Web 框架，核心简单，扩展灵活。

### 安装

```bash
pip install flask
```

### 最小应用

```python
from flask import Flask, jsonify, request

app = Flask(__name__)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/users")
def create_user():
    data = request.get_json()
    return jsonify({"id": 1, "name": data["name"]}), 201


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
```

### Flask 项目结构

```text
app/
  __init__.py
  config.py
  routes.py
  models.py
  services.py
  extensions.py
run.py
```

常见分层：

- `routes.py`：定义路由和请求入口。
- `services.py`：封装业务逻辑。
- `models.py`：定义数据模型。
- `extensions.py`：初始化数据库、缓存、认证等扩展。

## Django

Django 是全功能 Web 框架，强调约定、完整生态和快速交付。

### 安装与创建项目

```bash
pip install django
django-admin startproject config .
python manage.py startapp users
```

### 视图示例

```python
from django.http import JsonResponse


def health(request):
    return JsonResponse({"status": "ok"})
```

### URL 路由

```python
from django.urls import path
from . import views

urlpatterns = [
    path("health/", views.health),
]
```

### Django 适合的场景

- 后台管理系统。
- 内容管理系统。
- 用户、权限、表单、数据库操作较多的业务系统。
- 需要快速构建管理页面的项目。

Django 自带 ORM、Admin、认证、表单、模板和安全机制，适合业务功能密集型应用。

## FastAPI

FastAPI 是现代 Python API 框架，基于 Starlette 和 Pydantic，支持类型提示、自动参数校验和自动生成 OpenAPI 文档。

### 安装

```bash
pip install fastapi uvicorn
```

### 最小应用

```python
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class UserCreate(BaseModel):
    name: str
    age: int


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/users")
def create_user(user: UserCreate):
    return {"id": 1, "name": user.name, "age": user.age}
```

启动服务：

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 自动文档

FastAPI 默认提供：

- `/docs`：Swagger UI。
- `/redoc`：ReDoc 文档。
- `/openapi.json`：OpenAPI 描述文件。

### 异步接口

```python
import asyncio
from fastapi import FastAPI

app = FastAPI()


@app.get("/async-task")
async def async_task():
    await asyncio.sleep(1)
    return {"status": "done"}
```

如果函数内部调用的是阻塞库，即使写成 `async def` 也会阻塞事件循环。异步接口应配合异步数据库驱动、异步 HTTP 客户端等使用。

## 路由、请求与响应

Web 框架通常围绕路由、请求和响应组织代码。

| 概念 | 说明 |
|:---|:---|
| 路由 | URL 与处理函数的映射 |
| 请求 | 客户端发送的数据，包括 Header、Query、Body |
| 响应 | 服务端返回的数据，包括状态码、Header、Body |
| 中间件 | 请求前后执行的统一逻辑 |

### RESTful API 设计

```text
GET    /users       查询用户列表
GET    /users/1     查询单个用户
POST   /users       创建用户
PUT    /users/1     全量更新用户
PATCH  /users/1     部分更新用户
DELETE /users/1     删除用户
```

接口设计建议：

- URL 表示资源，HTTP 方法表示动作。
- 使用统一错误响应格式。
- 分页、排序、过滤使用 Query 参数。
- 请求和响应字段命名保持一致。

## 中间件

中间件用于处理跨业务逻辑，例如日志、认证、跨域、异常捕获和链路追踪。

FastAPI 中间件示例：

```python
import time
from fastapi import FastAPI, Request

app = FastAPI()


@app.middleware("http")
async def access_log(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    cost = time.time() - start
    print(request.method, request.url.path, response.status_code, cost)
    return response
```

中间件不应写复杂业务逻辑，避免影响所有请求。

## 数据校验

参数校验应放在系统边界。FastAPI 使用 Pydantic 自动校验请求体。

```python
from pydantic import BaseModel, Field

class UserCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    age: int = Field(ge=0, le=150)
```

Flask 和 Django 也可以通过 Marshmallow、Django Form、Django REST Framework Serializer 等方式做校验。

## 数据库集成

Web 框架通常通过 ORM 或数据库驱动访问数据库。

常见组合：

| 框架 | 常见数据库方案 |
|:---|:---|
| Flask | SQLAlchemy、Flask-SQLAlchemy |
| Django | Django ORM |
| FastAPI | SQLAlchemy、SQLModel、Tortoise ORM |

数据库访问建议：

- 一次请求内复用同一个数据库会话。
- 请求结束后释放连接。
- 写操作放入事务。
- 不在路由函数中堆复杂 SQL，封装到 repository 或 service 层。

## 认证与权限

常见认证方式包括 Cookie Session、JWT、OAuth2。

JWT Header 示例：

```text
Authorization: Bearer <token>
```

FastAPI 认证依赖示例：

```python
from fastapi import Depends, Header, HTTPException


def get_current_user(authorization: str = Header(default="")):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")
    return {"user_id": 1}
```

权限控制应在服务端执行，不应只依赖前端控制。

## 异常处理

统一异常处理可以让 API 返回一致格式。

```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    return JSONResponse(
        status_code=400,
        content={"code": "BAD_REQUEST", "message": str(exc)},
    )
```

建议定义统一响应结构：

```json
{
  "code": "BAD_REQUEST",
  "message": "invalid parameter",
  "data": null
}
```

## 测试

Web 应用需要覆盖接口测试、服务层测试和关键异常路径。

FastAPI 测试示例：

```python
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

测试时应隔离数据库、缓存和外部服务，必要时使用 mock 或测试容器。

## 部署

常见部署方式：

| 框架类型 | 推荐运行方式 |
|:---|:---|
| Flask / Django | Gunicorn + 多 worker |
| FastAPI / ASGI | Uvicorn / Gunicorn + UvicornWorker |
| 静态资源 | Nginx 或 CDN |

FastAPI 生产启动示例：

```bash
gunicorn main:app -k uvicorn.workers.UvicornWorker -w 4 -b 0.0.0.0:8000
```

部署时要关注进程数、超时、日志、健康检查、配置注入和优雅退出。

## 框架选择建议

| 场景 | 推荐 |
|:---|:---|
| 快速构建轻量 API | Flask / FastAPI |
| 后台管理和传统业务系统 | Django |
| 类型校验、自动文档、微服务 API | FastAPI |
| 实时通信、长连接 | FastAPI / Tornado |
| 团队已有成熟 Django 经验 | Django |

## 实践建议

- 路由层只处理协议转换，业务逻辑放到 service 层。
- 参数校验放在请求入口，数据库约束放在持久化层。
- 统一异常响应、日志格式和认证方式。
- API 文档和接口实现保持同步。
- 对数据库、缓存、外部 API 调用设置超时。
- 生产环境关闭 debug 模式。
- 通过健康检查接口支持部署平台探活。

## 小结

Python Web 框架各有侧重点。Flask 灵活轻量，Django 完整成熟，FastAPI 现代高效并适合 API 服务。实际项目中，框架只是基础，真正影响长期维护的是清晰分层、统一规范、可靠测试、稳定部署和可观测性。