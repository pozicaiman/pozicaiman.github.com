---
title: Python 系统编程
date: 2026-11-20 10:05:00
categories: [Python]
tags: [Python, Python基础, 系统编程, 自动化脚本]
---

# Python 系统编程

Python 系统编程主要关注程序与操作系统之间的交互，包括文件读写、目录管理、进程管理、环境变量、命令行参数、日志记录和常见自动化脚本。掌握这些能力后，可以用 Python 编写运维工具、批处理脚本、数据处理任务和系统集成程序。

## 系统编程

系统编程的核心目标是让程序能够调用操作系统能力。常见场景包括：

- 读取和写入本地文件。
- 遍历目录、复制、移动、删除文件。
- 获取环境变量和命令行参数。
- 调用外部命令。
- 创建子进程并读取执行结果。
- 编写可复用的自动化脚本。

Python 标准库已经覆盖了大部分系统编程需求，常用模块如下：

| 模块 | 作用 |
|:---|:---|
| `os` | 操作系统接口、环境变量、路径和进程基础能力 |
| `pathlib` | 面向对象的路径处理，推荐优先使用 |
| `shutil` | 高级文件操作，例如复制、移动、删除目录 |
| `subprocess` | 启动子进程并调用外部命令 |
| `sys` | 解释器相关信息、命令行参数、退出码 |
| `argparse` | 构建命令行工具参数解析 |
| `logging` | 标准日志记录 |

## 路径处理

推荐使用 `pathlib.Path` 处理路径，它比字符串拼接更安全、更清晰。

```python
from pathlib import Path

base_dir = Path("logs")
file_path = base_dir / "app.log"

print(file_path.name)      # app.log
print(file_path.suffix)    # .log
print(file_path.parent)    # logs
```

### 判断路径状态

```python
from pathlib import Path

path = Path("data/input.txt")

print(path.exists())   # 是否存在
print(path.is_file())  # 是否是文件
print(path.is_dir())   # 是否是目录
```

### 创建目录

```python
from pathlib import Path

output_dir = Path("output/reports")
output_dir.mkdir(parents=True, exist_ok=True)
```

`parents=True` 表示自动创建父目录，`exist_ok=True` 表示目录已存在时不报错。

## 文件操作

文件操作包括读文件、写文件、追加内容和二进制文件处理。

### 读取文本文件

```python
from pathlib import Path

path = Path("data.txt")
content = path.read_text(encoding="utf-8")
print(content)
```

也可以按行读取，适合处理大文件。

```python
from pathlib import Path

path = Path("data.txt")

with path.open("r", encoding="utf-8") as f:
    for line in f:
        print(line.strip())
```

### 写入文本文件

```python
from pathlib import Path

path = Path("output.txt")
path.write_text("hello Python\n", encoding="utf-8")
```

追加写入：

```python
from pathlib import Path

path = Path("output.txt")

with path.open("a", encoding="utf-8") as f:
    f.write("append line\n")
```

### 二进制文件

图片、压缩包、音视频等文件应使用二进制模式。

```python
from pathlib import Path

src = Path("image.png")
dst = Path("copy.png")

data = src.read_bytes()
dst.write_bytes(data)
```

## 目录遍历

### 遍历当前目录

```python
from pathlib import Path

for item in Path(".").iterdir():
    print(item)
```

### 递归查找文件

```python
from pathlib import Path

for path in Path(".").rglob("*.py"):
    print(path)
```

### 统计文件大小

```python
from pathlib import Path

total = 0

for path in Path(".").rglob("*.log"):
    if path.is_file():
        total += path.stat().st_size

print(f"total={total} bytes")
```

## 文件复制、移动和删除

`shutil` 提供了更高级的文件和目录操作能力。

```python
from pathlib import Path
import shutil

src = Path("data.txt")
dst = Path("backup/data.txt")
dst.parent.mkdir(parents=True, exist_ok=True)

shutil.copy2(src, dst)
```

常用操作：

| 操作 | 示例 |
|:---|:---|
| 复制文件 | `shutil.copy2(src, dst)` |
| 复制目录 | `shutil.copytree(src, dst)` |
| 移动文件或目录 | `shutil.move(src, dst)` |
| 删除目录树 | `shutil.rmtree(path)` |

删除文件前建议先判断是否存在。

```python
from pathlib import Path

path = Path("temp.txt")

if path.exists():
    path.unlink()
```

## 环境变量

环境变量常用于保存运行环境相关配置，例如数据库地址、访问密钥、运行模式等。

```python
import os

app_env = os.getenv("APP_ENV", "dev")
print(app_env)
```

设置环境变量：

```python
import os

os.environ["APP_ENV"] = "test"
```

注意：程序内设置的环境变量通常只影响当前进程及其子进程，不会永久写入系统配置。

## 命令行参数

简单脚本可以直接读取 `sys.argv`。

```python
import sys

print(sys.argv)
```

更推荐使用 `argparse` 构建清晰的命令行工具。

```python
import argparse

parser = argparse.ArgumentParser(description="文件行数统计工具")
parser.add_argument("file", help="待统计的文件路径")
parser.add_argument("--encoding", default="utf-8", help="文件编码")
args = parser.parse_args()

with open(args.file, "r", encoding=args.encoding) as f:
    count = sum(1 for _ in f)

print(count)
```

运行示例：

```bash
python count_lines.py data.txt --encoding utf-8
```

## 调用外部命令

`subprocess` 用于调用系统命令或其他程序。

```python
import subprocess

result = subprocess.run(
    ["python", "--version"],
    capture_output=True,
    text=True,
    check=True,
)

print(result.stdout)
```

关键参数：

| 参数 | 说明 |
|:---|:---|
| `capture_output=True` | 捕获标准输出和标准错误 |
| `text=True` | 返回字符串而不是字节 |
| `check=True` | 命令失败时抛出异常 |
| `timeout=10` | 限制执行时间 |

调用外部命令时，优先传入列表参数，避免直接拼接命令字符串。

## 进程与退出码

脚本退出时可以通过 `sys.exit()` 返回退出码。通常 `0` 表示成功，非 `0` 表示失败。

```python
import sys

success = True

if success:
    sys.exit(0)
else:
    sys.exit(1)
```

在自动化任务、CI/CD 和定时任务中，退出码非常重要，调用方会根据退出码判断任务是否成功。

## 日志记录

相比直接使用 `print()`，`logging` 更适合正式脚本和服务程序。

```python
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

logging.info("program started")
logging.warning("disk usage is high")
logging.error("task failed")
```

常见日志级别：

| 级别 | 说明 |
|:---|:---|
| `DEBUG` | 调试信息 |
| `INFO` | 普通运行信息 |
| `WARNING` | 警告信息 |
| `ERROR` | 错误信息 |
| `CRITICAL` | 严重错误 |

## 常见自动化脚本示例

下面示例用于清理指定目录下超过 7 天的 `.log` 文件。

```python
from datetime import datetime, timedelta
from pathlib import Path

log_dir = Path("logs")
expire_time = datetime.now() - timedelta(days=7)

for path in log_dir.rglob("*.log"):
    if not path.is_file():
        continue

    modified_time = datetime.fromtimestamp(path.stat().st_mtime)
    if modified_time < expire_time:
        print(f"delete {path}")
        path.unlink()
```

## 实践建议

- 路径处理优先使用 `pathlib`，少用字符串拼接路径。
- 文件读写始终显式指定 `encoding="utf-8"`。
- 操作文件前先判断路径是否存在、是否为文件或目录。
- 删除文件、目录前增加确认逻辑或 dry-run 模式。
- 调用外部命令时设置 `timeout`，避免脚本卡死。
- 自动化脚本应使用日志和退出码，便于接入定时任务或 CI。
- 对外部输入、文件路径、命令返回值做好异常处理。

## 小结

Python 系统编程的重点是熟悉标准库能力，并用稳定、可读、可维护的方式调用操作系统资源。掌握路径处理、文件操作、目录遍历、环境变量、命令行参数、外部命令和日志记录后，就可以编写大多数日常自动化脚本。