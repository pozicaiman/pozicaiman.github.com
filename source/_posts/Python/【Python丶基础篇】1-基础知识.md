# Python 基础知识

Python 是一种解释型、动态类型、面向对象的高级编程语言。它语法简洁，标准库丰富，常用于脚本自动化、Web 后端、数据分析、人工智能、运维工具和系统集成等场景。

学习 Python 基础时，建议先建立三条主线：

- 数据如何表示：变量、数字、字符串、列表、元组、字典、集合。
- 逻辑如何控制：条件判断、循环、异常处理。
- 程序如何组织：函数、模块、包、类与对象。

## 变量类型

Python 中变量不需要提前声明类型，赋值时解释器会根据对象自动绑定类型。

```python
name = "Python"
age = 30
price = 99.8
is_active = True
```

常见基础类型如下：

| 类型 | 示例 | 说明 |
|:---|:---|:---|
| `int` | `10` | 整数 |
| `float` | `3.14` | 浮点数 |
| `bool` | `True` / `False` | 布尔值 |
| `str` | `"hello"` | 字符串 |
| `list` | `[1, 2, 3]` | 可变序列 |
| `tuple` | `(1, 2, 3)` | 不可变序列 |
| `dict` | `{"name": "Tom"}` | 键值对映射 |
| `set` | `{1, 2, 3}` | 无序不重复集合 |

### 动态类型与强类型

Python 是动态类型语言，变量名只是对象引用，同一个变量名可以重新绑定到不同类型的对象。

```python
value = 100
value = "one hundred"
```

但 Python 也是强类型语言，不会在不明确的情况下自动做危险转换。

```python
age = 18
# print("age=" + age)  # TypeError
print("age=" + str(age))
```

### 类型查看与转换

```python
num = "100"
print(type(num))       # <class 'str'>
print(int(num) + 20)   # 120
```

常用转换函数：

- `int()`：转换为整数。
- `float()`：转换为浮点数。
- `str()`：转换为字符串。
- `bool()`：转换为布尔值。
- `list()` / `tuple()` / `set()`：序列与集合转换。

## 循环判断

程序控制流主要包括条件判断和循环。

### 条件判断

```python
score = 85

if score >= 90:
    print("优秀")
elif score >= 60:
    print("及格")
else:
    print("不及格")
```

Python 使用缩进表示代码块，通常使用 4 个空格。不要混用 Tab 和空格。

### 比较运算与逻辑运算

| 运算符 | 说明 | 示例 |
|:---|:---|:---|
| `==` | 等于 | `a == b` |
| `!=` | 不等于 | `a != b` |
| `>` / `<` | 大于 / 小于 | `a > b` |
| `>=` / `<=` | 大于等于 / 小于等于 | `a >= b` |
| `and` | 与 | `a > 0 and b > 0` |
| `or` | 或 | `a > 0 or b > 0` |
| `not` | 非 | `not flag` |

### for 循环

`for` 循环常用于遍历可迭代对象，例如列表、字符串、字典、文件对象等。

```python
names = ["Tom", "Jerry", "Alice"]

for name in names:
    print(name)
```

配合 `range()` 可以生成数字序列。

```python
for i in range(1, 6):
    print(i)
```

### while 循环

`while` 循环适合条件满足时持续执行。

```python
count = 0

while count < 3:
    print(count)
    count += 1
```

### break、continue 与 else

- `break`：立即结束整个循环。
- `continue`：跳过本次循环，进入下一次循环。
- `else`：循环未被 `break` 中断时执行。

```python
for i in range(5):
    if i == 3:
        break
    print(i)
else:
    print("循环正常结束")
```

上面代码不会执行 `else`，因为循环被 `break` 中断。

## 字符串

字符串是不可变序列，用于表示文本数据。可以使用单引号、双引号或三引号定义。

```python
name = "Python"
message = 'hello'
text = """多行字符串
可以跨越多行"""
```

### 字符串索引与切片

```python
s = "Python"

print(s[0])     # P
print(s[-1])    # n
print(s[0:3])   # Pyt
print(s[::2])   # Pto
```

切片格式为 `start:stop:step`，包含 `start`，不包含 `stop`。

### 常用方法

| 方法 | 说明 | 示例 |
|:---|:---|:---|
| `strip()` | 去除首尾空白 | `s.strip()` |
| `lower()` / `upper()` | 大小写转换 | `s.lower()` |
| `replace()` | 替换子串 | `s.replace("a", "b")` |
| `split()` | 拆分字符串 | `s.split(",")` |
| `join()` | 拼接序列 | `",".join(items)` |
| `find()` | 查找子串位置 | `s.find("py")` |
| `startswith()` | 判断开头 | `s.startswith("http")` |

### 格式化字符串

推荐使用 f-string，语法简洁、可读性好。

```python
name = "Tom"
age = 18

print(f"name={name}, age={age}")
```

也可以控制数字格式。

```python
price = 12.3456
print(f"price={price:.2f}")  # price=12.35
```

## 列表和元组

列表和元组都是有序序列，区别在于列表可变，元组不可变。

### 列表

```python
numbers = [1, 2, 3]
numbers.append(4)
numbers.insert(0, 0)
numbers.remove(2)

print(numbers)  # [0, 1, 3, 4]
```

常用列表操作：

| 操作 | 说明 |
|:---|:---|
| `append(x)` | 追加元素 |
| `insert(i, x)` | 在指定位置插入 |
| `remove(x)` | 删除第一个匹配元素 |
| `pop()` | 删除并返回末尾元素 |
| `sort()` | 原地排序 |
| `reverse()` | 原地反转 |

### 列表推导式

列表推导式用于快速生成列表。

```python
squares = [x * x for x in range(1, 6)]
print(squares)  # [1, 4, 9, 16, 25]
```

也可以加入条件过滤。

```python
even_numbers = [x for x in range(10) if x % 2 == 0]
print(even_numbers)
```

### 元组

元组创建后不能修改，适合表示固定结构的数据。

```python
point = (10, 20)
x, y = point

print(x, y)
```

只有一个元素的元组必须带逗号。

```python
single = (1,)
```

### 列表与元组的选择

- 数据需要频繁增删改：使用 `list`。
- 数据结构固定、不希望被修改：使用 `tuple`。
- 函数返回多个值：常用 `tuple` 解包。

## 字典

字典用于存储键值对，键必须是可哈希对象，常用键类型包括字符串、数字、元组。

```python
user = {
    "name": "Tom",
    "age": 18,
    "city": "Shanghai",
}

print(user["name"])
```

### 增删改查

```python
user = {"name": "Tom", "age": 18}

user["city"] = "Shanghai"      # 新增
user["age"] = 20               # 修改
print(user.get("email", ""))   # 安全读取
del user["city"]                # 删除
```

使用 `get()` 可以避免键不存在时抛出 `KeyError`。

### 遍历字典

```python
user = {"name": "Tom", "age": 18}

for key in user:
    print(key, user[key])

for key, value in user.items():
    print(key, value)
```

### 字典推导式

```python
squares = {x: x * x for x in range(1, 6)}
print(squares)
```

## 集合

集合是无序不重复元素容器，适合去重和集合运算。

```python
numbers = [1, 2, 2, 3, 3, 3]
unique_numbers = set(numbers)
print(unique_numbers)  # {1, 2, 3}
```

常见集合运算：

```python
a = {1, 2, 3}
b = {3, 4, 5}

print(a | b)  # 并集 {1, 2, 3, 4, 5}
print(a & b)  # 交集 {3}
print(a - b)  # 差集 {1, 2}
```

## 函数

函数用于封装可复用逻辑，降低重复代码。

```python
def add(a, b):
    return a + b

result = add(1, 2)
print(result)
```

### 默认参数与关键字参数

```python
def greet(name, message="hello"):
    print(f"{message}, {name}")

greet("Tom")
greet(name="Jerry", message="hi")
```

默认参数应尽量使用不可变对象，避免使用可变列表作为默认值。

```python
def append_item(item, items=None):
    if items is None:
        items = []
    items.append(item)
    return items
```

### 可变参数

```python
def total(*args):
    return sum(args)

print(total(1, 2, 3))
```

```python
def print_user(**kwargs):
    for key, value in kwargs.items():
        print(key, value)

print_user(name="Tom", age=18)
```

## 模块和包

模块是一个 `.py` 文件，包是包含 `__init__.py` 的目录。通过模块和包可以组织大型项目。

```python
import math

print(math.sqrt(16))
```

也可以导入指定对象。

```python
from math import sqrt

print(sqrt(16))
```

### 主程序入口

```python
def main():
    print("start")

if __name__ == "__main__":
    main()
```

这种写法可以让文件既能被直接运行，也能被其他模块导入。

## 异常处理

异常处理用于捕获运行时错误，避免程序直接中断。

```python
try:
    num = int(input("请输入数字："))
    print(100 / num)
except ValueError:
    print("输入不是数字")
except ZeroDivisionError:
    print("不能除以 0")
else:
    print("没有异常时执行")
finally:
    print("无论是否异常都会执行")
```

常见异常：

| 异常 | 场景 |
|:---|:---|
| `ValueError` | 值不合法，例如 `int("abc")` |
| `TypeError` | 类型不匹配 |
| `KeyError` | 字典键不存在 |
| `IndexError` | 序列索引越界 |
| `FileNotFoundError` | 文件不存在 |

## 面向对象基础

Python 支持面向对象编程。类用于描述对象的属性和行为。

```python
class User:
    def __init__(self, name, age):
        self.name = name
        self.age = age

    def say_hello(self):
        print(f"hello, I am {self.name}")

user = User("Tom", 18)
user.say_hello()
```

### 类、对象与实例属性

- 类：对象的模板，例如 `User`。
- 对象：由类创建出的具体实例，例如 `user`。
- 属性：对象保存的数据，例如 `name`、`age`。
- 方法：对象可以执行的行为，例如 `say_hello()`。

### 继承

```python
class Animal:
    def speak(self):
        print("animal sound")

class Dog(Animal):
    def speak(self):
        print("wang")

Dog().speak()
```

继承可以复用父类能力，也可以通过重写方法实现差异化行为。

## 常用内置函数

Python 提供了很多常用内置函数。

| 函数 | 说明 | 示例 |
|:---|:---|:---|
| `len()` | 获取长度 | `len(items)` |
| `type()` | 查看类型 | `type(value)` |
| `range()` | 生成整数序列 | `range(10)` |
| `enumerate()` | 遍历时获取索引 | `enumerate(items)` |
| `zip()` | 并行遍历多个序列 | `zip(a, b)` |
| `map()` | 映射处理 | `map(func, items)` |
| `filter()` | 过滤元素 | `filter(func, items)` |
| `sorted()` | 返回排序后的新列表 | `sorted(items)` |
| `sum()` | 求和 | `sum(numbers)` |

示例：

```python
names = ["Tom", "Jerry", "Alice"]

for index, name in enumerate(names, start=1):
    print(index, name)
```

## 编码规范建议

良好的编码习惯可以提升代码可读性和可维护性。

- 使用 4 个空格缩进，不混用 Tab。
- 变量和函数使用小写加下划线，例如 `user_name`。
- 类名使用大驼峰命名，例如 `UserService`。
- 常量使用大写加下划线，例如 `MAX_RETRY`。
- 函数只做一件事，保持短小清晰。
- 对外部输入、文件、网络请求等边界场景做好异常处理。
- 优先写可读代码，不为了炫技过度压缩表达。

## 小结

Python 基础知识的重点不是记住所有语法细节，而是理解数据结构、控制流和程序组织方式。掌握变量类型、循环判断、字符串、列表、元组、字典、函数、模块、异常和类之后，就可以继续学习系统编程、网络编程、数据库编程以及 Web 开发等进阶内容。
