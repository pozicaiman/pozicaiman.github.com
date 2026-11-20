# Python 数据库编程

Python 数据库编程主要用于连接数据库、执行 SQL 或命令、读写业务数据、处理事务和封装数据访问层。常见数据库可以分为关系型数据库、缓存数据库、文档数据库和嵌入式数据库。

## 数据库编程基础

无论使用哪种数据库，常见流程都类似：

1. 安装对应驱动。
2. 创建连接。
3. 创建游标或客户端对象。
4. 执行查询或写入命令。
5. 处理结果。
6. 提交或回滚事务。
7. 关闭连接。

关系型数据库通常遵循 DB-API 规范，典型写法如下：

```python
import sqlite3

conn = sqlite3.connect("demo.db")
cursor = conn.cursor()

cursor.execute("select sqlite_version()")
print(cursor.fetchone())

cursor.close()
conn.close()
```

## mysql

MySQL 是常见的关系型数据库，适用于 Web 应用、业务系统和数据存储。Python 中常用驱动包括 `pymysql`、`mysqlclient` 和 SQLAlchemy。

### 安装驱动

```bash
pip install pymysql
```

### 连接 MySQL

```python
import pymysql

conn = pymysql.connect(
    host="127.0.0.1",
    port=3306,
    user="root",
    password="password",
    database="test",
    charset="utf8mb4",
)

try:
    with conn.cursor() as cursor:
        cursor.execute("select version()")
        print(cursor.fetchone())
finally:
    conn.close()
```

### 参数化查询

不要用字符串拼接 SQL，避免 SQL 注入。

```python
sql = "select id, name from users where id = %s"

with conn.cursor() as cursor:
    cursor.execute(sql, (1,))
    user = cursor.fetchone()
    print(user)
```

### 插入数据与事务

```python
sql = "insert into users(name, age) values(%s, %s)"

try:
    with conn.cursor() as cursor:
        cursor.execute(sql, ("Tom", 18))
    conn.commit()
except Exception:
    conn.rollback()
    raise
```

事务的基本原则：成功后 `commit()`，失败时 `rollback()`。

## redis

Redis 是内存数据结构存储系统，常用于缓存、分布式锁、计数器、排行榜、消息队列和会话存储。

### 安装驱动

```bash
pip install redis
```

### 基础操作

```python
import redis

client = redis.Redis(
    host="127.0.0.1",
    port=6379,
    db=0,
    decode_responses=True,
)

client.set("name", "Tom", ex=60)
print(client.get("name"))
```

### 常用数据结构

| 类型 | 命令示例 | 场景 |
|:---|:---|:---|
| String | `set` / `get` | 缓存、计数器 |
| Hash | `hset` / `hgetall` | 对象属性 |
| List | `lpush` / `brpop` | 简单队列 |
| Set | `sadd` / `smembers` | 去重集合 |
| ZSet | `zadd` / `zrange` | 排行榜 |

### 缓存读取模式

```python
import json

key = "user:1"
value = client.get(key)

if value is None:
    user = {"id": 1, "name": "Tom"}
    client.set(key, json.dumps(user, ensure_ascii=False), ex=300)
else:
    user = json.loads(value)

print(user)
```

缓存要设置过期时间，避免长期占用内存。

## mongodb

MongoDB 是文档数据库，适合存储结构灵活的 JSON 类数据。

### 安装驱动

```bash
pip install pymongo
```

### 连接和写入

```python
from pymongo import MongoClient

client = MongoClient("mongodb://localhost:27017")
db = client["test"]
collection = db["users"]

result = collection.insert_one({"name": "Tom", "age": 18})
print(result.inserted_id)
```

### 查询和更新

```python
user = collection.find_one({"name": "Tom"})
print(user)

collection.update_one(
    {"name": "Tom"},
    {"$set": {"age": 20}},
)

for item in collection.find({"age": {"$gte": 18}}):
    print(item)
```

MongoDB 查询条件接近 JSON 结构，复杂查询要注意索引设计。

## postgresql

PostgreSQL 是功能强大的关系型数据库，支持复杂 SQL、事务、JSON、数组、全文检索和扩展机制。

### 安装驱动

```bash
pip install psycopg2-binary
```

### 连接 PostgreSQL

```python
import psycopg2

conn = psycopg2.connect(
    host="127.0.0.1",
    port=5432,
    user="postgres",
    password="password",
    dbname="test",
)

try:
    with conn.cursor() as cursor:
        cursor.execute("select version()")
        print(cursor.fetchone())
finally:
    conn.close()
```

### 参数化查询

```python
with conn.cursor() as cursor:
    cursor.execute("select id, name from users where id = %s", (1,))
    print(cursor.fetchone())
```

PostgreSQL 和 MySQL 的 Python 参数占位符在常用驱动中都可以使用 `%s`，但不要用 Python 字符串格式化拼接 SQL。

## sqlite

SQLite 是轻量级嵌入式数据库，不需要单独部署服务，适合本地工具、小型应用、测试环境和单机数据存储。

### 创建表和插入数据

```python
import sqlite3

conn = sqlite3.connect("demo.db")

try:
    cursor = conn.cursor()
    cursor.execute(
        """
        create table if not exists users (
            id integer primary key autoincrement,
            name text not null,
            age integer
        )
        """
    )
    cursor.execute("insert into users(name, age) values(?, ?)", ("Tom", 18))
    conn.commit()
finally:
    conn.close()
```

SQLite 的参数占位符通常使用 `?`。

### 查询数据

```python
import sqlite3

with sqlite3.connect("demo.db") as conn:
    cursor = conn.cursor()
    cursor.execute("select id, name, age from users")
    for row in cursor.fetchall():
        print(row)
```

## ORM 与 SQLAlchemy

ORM 用对象方式操作数据库，可以减少重复 SQL，但也需要理解底层 SQL 行为。

### 安装 SQLAlchemy

```bash
pip install sqlalchemy
```

### 基础示例

```python
from sqlalchemy import Column, Integer, String, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

Base = declarative_base()

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    name = Column(String(64), nullable=False)
    age = Column(Integer)

engine = create_engine("sqlite:///demo.db", echo=False)
Base.metadata.create_all(engine)

Session = sessionmaker(bind=engine)
session = Session()

user = User(name="Tom", age=18)
session.add(user)
session.commit()

for item in session.query(User).all():
    print(item.id, item.name)

session.close()
```

ORM 适合业务 CRUD，但复杂查询、性能优化和批量操作仍应理解 SQL。

## 连接池

数据库连接创建成本较高，服务端程序通常需要连接池。

连接池的作用：

- 复用连接，减少频繁创建和销毁。
- 控制最大连接数，保护数据库。
- 提升并发访问性能。

SQLAlchemy 默认支持连接池，也可以通过参数配置：

```python
from sqlalchemy import create_engine

engine = create_engine(
    "mysql+pymysql://root:password@127.0.0.1:3306/test",
    pool_size=5,
    max_overflow=10,
    pool_recycle=3600,
)
```

## 事务处理

事务用于保证一组操作要么全部成功，要么全部失败。

```python
try:
    cursor.execute("update accounts set balance = balance - %s where id = %s", (100, 1))
    cursor.execute("update accounts set balance = balance + %s where id = %s", (100, 2))
    conn.commit()
except Exception:
    conn.rollback()
    raise
```

事务常用于转账、订单、库存扣减等一致性要求较高的场景。

## 安全与性能建议

- 永远使用参数化查询，禁止拼接用户输入到 SQL。
- 数据库密码不要写死在代码中，使用环境变量或密钥管理系统。
- 查询字段只取需要的列，避免 `select *`。
- 高频查询字段要建立索引。
- 批量写入时使用批量接口，减少多次网络往返。
- 服务程序使用连接池，脚本程序确保连接关闭。
- 大结果集使用分页或流式读取，避免一次性加载全部数据。
- Redis 缓存必须设置合理过期时间，避免缓存雪崩和内存膨胀。

## 其他数据库

Python 也可以连接很多其他数据库或存储系统：

| 数据库 | 类型 | Python 常用库 |
|:---|:---|:---|
| Elasticsearch | 搜索引擎 | `elasticsearch` |
| ClickHouse | 列式数据库 | `clickhouse-connect` |
| InfluxDB | 时序数据库 | `influxdb-client` |
| Neo4j | 图数据库 | `neo4j` |
| Cassandra | 宽列数据库 | `cassandra-driver` |
| DuckDB | 嵌入式分析数据库 | `duckdb` |

选择数据库时，要根据数据模型、查询模式、一致性要求、吞吐量、延迟和运维成本综合判断。

## 小结

Python 数据库编程的核心不是记住某个驱动的全部 API，而是理解连接、查询、事务、连接池、安全和性能这些共性问题。关系型数据库重视 SQL、事务和索引；Redis 重视数据结构和过期策略；MongoDB 重视文档模型和索引；SQLite 适合轻量单机场景。