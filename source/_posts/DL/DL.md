---
title: 深度学习全景：从基础到前沿
date: 2026-09-24 12:01:30
categories: [深度学习]
tags: [深度学习, PyTorch, 机器学习]
---

## 1. 引言：从机器学习到深度学习

[待写]

## 2. 神经网络基础

[待写]

## 3. 训练机制：梯度下降与反向传播

这是深度学习最核心的一章：一个网络能「学会」东西，靠的就是**梯度下降 + 反向传播**这套机制。本节从直觉出发，给出完整的数学推导。

### 3.1 训练的本质：把「学习」变成优化问题

一个神经网络的参数是所有权重 $W^l$ 和偏置 $b^l$。训练就是寻找一组参数，让损失函数 $L$ 最小：

$$
\min_{W,b} \; L(W, b)
$$

为什么不能直接解析求解？因为参数动辄百万、千万级，$L$ 又是参数的高度非线性函数，没有闭式解。所以我们采用**迭代逼近**的方式：从某个初始参数出发，反复朝着「让 $L$ 变小」的方向移动。

### 3.2 梯度下降：下山的直觉

想象你在浓雾中的山上，想走到最低谷。你只能靠脚底的感觉判断哪个方向是下坡——而**梯度**正是函数上升最快的方向，负梯度就是下降最快的方向。于是每一步都朝负梯度方向迈步，这就是梯度下降：

$$
W \leftarrow W - \eta \frac{\partial L}{\partial W}, \qquad b \leftarrow b - \eta \frac{\partial L}{\partial b}
$$

其中 $\eta$ 是**学习率**：
- $\eta$ 太小 → 收敛极慢，甚至卡住
- $\eta$ 太大 → 越过谷底来回震荡，甚至发散

梯度下降的名字很多——全量梯度下降（GD）、随机梯度下降（SGD）、小批量梯度下降（mini-batch GD），区别只在每次用多少样本估计梯度，我们会在 3.12 节展开。

### 3.3 链式法则：反向传播的数学地基

回到微积分最基础的**链式法则**：若 $y = f(u)$ 且 $u = g(x)$，则

$$
\frac{dy}{dx} = \frac{dy}{du} \cdot \frac{du}{dx}
$$

复合函数层层嵌套，导数就一层层相乘。神经网络正是一个超大型复合函数，反向传播不过是在这个复合函数上系统地应用链式法则。

### 3.4 符号体系与计算图

先约定记号（此后全文沿用）：

- 第 $l$ 层的权重矩阵 $W^l$，偏置向量 $b^l$
- 线性输出 $z^l = W^l a^{l-1} + b^l$
- 激活输出 $a^l = \sigma(z^l)$（$\sigma$ 为激活函数）
- $L$ 为总层数，第 $L$ 层为输出层
- 核心定义：第 $l$ 层的**误差** $\delta^l = \dfrac{\partial L}{\partial z^l}$

**计算图**记录了前向传播中所有中间量及其依赖关系。以单隐藏层网络（2 输入 → 2 隐元 → 1 输出）为例：

```text
x ──► z¹ = W¹x + b¹ ──► a¹ = σ(z¹) ──► z² = W²a¹ + b² ──► a² = σ(z²) ──► L = ℓ(a², y)
       ▲                      ▲                     ▲                     ▲
      W¹, b¹                 σ                      W², b²                ℓ
```

前向传播沿箭头向右：计算每层的 $z^l, a^l$，最终得到损失 $L$。反向传播则沿箭头向左：把 $L$ 对参数的梯度逐层回传。

### 3.5 前向传播：一镜到底

对每一层 $l = 1, \dots, L$ 依次计算：

$$
z^l = W^l a^{l-1} + b^l, \qquad a^l = \sigma(z^l)
$$

其中 $a^0 = x$（输入）。最终损失 $L = \ell(a^L, y)$ 度量预测与真实标签的差距。

透过计算图可以直接读出一个关键事实：**$L$ 对任何一层参数的依赖，都要穿过其后所有层**。这正是「误差逐层传导」的来源。

### 3.6 反向传播的核心思想

我们要的是 $\dfrac{\partial L}{\partial W^l}$ 和 $\dfrac{\partial L}{\partial b^l}$。直接对每层暴力展开链式法则会指数爆炸；反向传播的聪明之处在于**复用**：先算出输出层的误差 $\delta^L$，然后递归地算出前一层误差 $\delta^{L-1}, \delta^{L-2}, \dots$，最后每层的参数梯度只需一次简单乘法。

具体分三步：

1. **输出层误差** $\delta^L$
2. **误差回传**：$\delta^l \to \delta^{l-1}$
3. **参数梯度**：由 $\delta^l$ 得到 $\dfrac{\partial L}{\partial W^l}, \dfrac{\partial L}{\partial b^l}$

下面逐一推导。

### 3.7 输出层推导：softmax + 交叉熵

以分类任务为例，输出层先过 **softmax** 把 logits 变成概率分布：

$$
a_j^L = \frac{e^{z_j^L}}{\sum_k e^{z_k^L}}
$$

损失用**交叉熵**：

$$
L = -\sum_j y_j \log a_j^L
$$

其中 $y_j$ 是 one-hot 标签。现在推导输出层误差 $\delta_j^L = \dfrac{\partial L}{\partial z_j^L}$。由链式法则：

$$
\delta_j^L = \sum_k \frac{\partial L}{\partial a_k^L} \cdot \frac{\partial a_k^L}{\partial z_j^L}
$$

交叉熵部分很简单：$\dfrac{\partial L}{\partial a_k^L} = -\dfrac{y_k}{a_k^L}$。softmax 的偏导要分两种情况（这是本节唯一的计算"重活"）：

$$
\frac{\partial a_k^L}{\partial z_j^L} =
\begin{cases}
a_j^L (1 - a_j^L), & k = j \\
-a_k^L a_j^L, & k \ne j
\end{cases}
$$

代入整理（把 $k=j$ 与 $k\ne j$ 两项分开合并）：

$$
\delta_j^L = -\frac{y_j}{a_j^L} a_j^L(1-a_j^L) + \sum_{k \ne j} \frac{y_k}{a_k^L} a_k^L a_j^L
= -y_j(1-a_j^L) + \sum_{k \ne j} y_k \, a_j^L
$$

$$
= -y_j + a_j^L \sum_k y_k = a_j^L - y_j
$$

（最后一步用到 $\sum_k y_k = 1$。）于是得到**输出层误差的极简形式**：

$$
\delta^L = a^L - y
$$

这个漂亮的结果只在 softmax + 交叉熵这个组合下成立——这正是实践中几乎总用这对组合的原因之一。

### 3.8 隐藏层推导：误差如何反向流动

现在推导 $\delta^l \to \delta^{l-1}$ 的递推式。$L$ 对前一层的依赖经过 $z_j^l = \sum_k W_{jk}^l a_k^{l-1} + b_j^l$，即 $z^l = W^l a^{l-1} + b^l$。对第 $l-1$ 层的误差：

$$
\delta_j^{l-1} = \frac{\partial L}{\partial z_j^{l-1}} = \sum_k \frac{\partial L}{\partial z_k^l}
\cdot \frac{\partial z_k^l}{\partial z_j^{l-1}}
$$

其中第一项就是 $\delta_k^l$；第二项再次用链式法则：

$$
\frac{\partial z_k^l}{\partial z_j^{l-1}} = W_{kj}^l \, \sigma'(z_j^{l-1})
$$

于是：

$$
\delta_j^{l-1} = \sigma'(z_j^{l-1}) \sum_k W_{kj}^l \delta_k^l
$$

写成向量形式，就是反向传播招牌式的**误差回传公式**：

$$
\boxed{\;\delta^{l} = (W^{l+1})^T \delta^{l+1} \odot \sigma'(z^{l})\;}
$$

其中 $\odot$ 是逐元素（Hadamard）乘积。几何理解：误差从后层沿转置权重 $(W^{l+1})^T$「分摊」回来，再被激活函数导数 $\sigma'(z^l)$ 这个闸门缩放——闸门接近 0，梯度就传不过去，这正是 3.11 节梯度消失的根源。

### 3.9 权重与偏置的梯度

最后一步。已知 $\delta^l = \dfrac{\partial L}{\partial z^l}$，而 $z^l = W^l a^{l-1} + b^l$，对参数直接求偏导：

$$
\frac{\partial L}{\partial W^l} = \delta^l (a^{l-1})^T, \qquad
\frac{\partial L}{\partial b^l} = \delta^l
$$

推导只需一步链式法则：$\dfrac{\partial L}{\partial W_{jk}^l} = \delta_j^l \, a_k^{l-1}$，合成矩阵即上式。

**全套反向传播算法**（BP）：

1. 前向传播：算出 $z^1, a^1, \dots, z^L, a^L, L$
2. 输出层误差：$\delta^L = a^L - y$
3. 逐层回传：$\delta^l = (W^{l+1})^T \delta^{l+1} \odot \sigma'(z^l)$，$l = L-1, \dots, 1$
4. 参数更新：$W^l \leftarrow W^l - \eta \delta^l (a^{l-1})^T$，$b^l \leftarrow b^l - \eta \delta^l$

这套流程对任意层数都成立——上面从单隐藏层推广到任意 $L$ 层，记号里唯一的「深度」体现在第 3 步的循环。

### 3.10 向量化视角：和代码一一对应

实际框架（PyTorch 等）不会手写逐层循环，而是借助自动微分。但理解向量化能让你看懂框架在做什么：

- 每个 $\delta^l$ 是形状为「(本层神经元数, batch 大小)」的矩阵
- 参数梯度 $\delta^l (a^{l-1})^T$ 是外积，一次算出一整层所有权重梯度
- 梯度从输出层「流」向输入层时，数据形状逐层变化，但运算模式完全相同

正是这种规整的矩阵运算，让 GPU 能并行加速——反向传播慢不慢，几乎完全取决于你能否把计算写成矩阵操作。

### 3.11 梯度消失与爆炸：深层网络的阿喀琉斯之踵

回传公式里有个隐患：$\delta^l$ 的传播要反复乘以 $\sigma'(z)$。若激活函数是 sigmoid/tanh，其导数最大只有 0.25，多层连乘后梯度指数级衰减——浅层几乎学不到东西，这就是**梯度消失**；反过来若权重初始化过大，梯度又会爆炸。两者都会让深层网络难以训练。

**常用对策**（后文章节会逐个展开）：

- 激活函数换成 **ReLU**（正区间导数为 1，缓解消失）
- 合理的**权重初始化**（如 He / Xavier）
- 批归一化（BatchNorm）
- 残差连接（ResNet 的核心思想）
- 更稳健的优化器 + 学习率调度

### 3.12 优化器对比：SGD / Momentum / Adam

梯度下降只告诉方向，怎么走是个工程问题。下面是三种主流优化器。

**SGD**（最朴素）：直接用当前样本的小批量梯度。

$$
g = \frac{1}{m}\sum_i \nabla L_i, \qquad W \leftarrow W - \eta g
$$

优点：简单、泛化性好；缺点：方向噪声大、在峡谷地形来回震荡（如上图 zig-zag）。

**Momentum**：引入「动量」，让更新方向积累历史梯度，像下山时带惯性。

$$
v \leftarrow \beta v + g, \qquad W \leftarrow W - \eta v
$$

震荡被平滑，能更快冲出平坦区。$\beta$ 常取 0.9。

**Adam**（Adaptive Moment Estimation）：进一步为每个参数维护梯度的一阶矩 $m$ 与二阶矩 $v$，做偏差修正后自适应调整每维学习率。

$$
m \leftarrow \beta_1 m + (1-\beta_1) g, \quad
v \leftarrow \beta_2 v + (1-\beta_2) g^2
$$

$$
\hat{m} = \frac{m}{1-\beta_1^t}, \quad \hat{v} = \frac{v}{1-\beta_2^t}, \quad
W \leftarrow W - \eta \frac{\hat{m}}{\sqrt{\hat{v}} + \epsilon}
$$

**工程建议**：多数现代任务直接用 Adam（$\beta_1=0.9, \beta_2=0.999, \epsilon=10^{-8}$）能快速收敛到不错的结果；若要追求极致泛化性能，可在后期切换或对比 SGD + Momentum，配合学习率调度（warmup → cosine decay）效果更佳。**优化器不改变损失面，只改变到达低点的路径**——这一章推导的损失函数与梯度才是根本。

### 3.13 小结

- 训练 = 对损失函数做迭代优化，梯度下降是最基本手段
- 反向传播 = 用链式法则高效计算所有参数梯度：$\delta^L = a^L - y$，随后 $\delta^l = (W^{l+1})^T \delta^{l+1} \odot \sigma'(z^l)$
- 参数梯度只需 $\delta^l$ 与激活输出的一步乘法
- 深度带来梯度消失/爆炸风险，激活函数、初始化、归一化、残差连接是对策
- 优化器解决「怎么走」，SGD 简单稳健，Adam 快速省心

下一章，我们把这一章的知识真正用起来——用 PyTorch 从零训练一个手写数字识别模型。

## 4. 实战：MNIST 从零训练（PyTorch）

[待写]

## 5. 架构演进：CNN → RNN → Transformer

[待写]

## 6. 2026 最新进展：LLM、多模态与前沿架构

[待写]

## 7. 学习路线：读论文 & 上手训练

[待写]