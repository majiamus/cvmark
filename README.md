# CVMARK 模块

## 描述

CVMARK 是一个基于 TypeScript 开发的图形标注编辑器模块，使用 SVG 和 Canvas 技术实现。它提供了一个功能丰富的画布，用于查看、绘制和编辑标注。

## 安装

```bash
npm install cvmark
```

## 开发

代码检查（使用 Biome）：

```bash
npm run lint
```

代码格式化：

```bash
npm run format
```

## API 方法

有关 API 方法、参数和返回类型的详细信息，请查看 `src/core/canvas.ts` 文件。

主要 API 包括：

- `html()` - 获取画布的 HTML 元素
- `setup()` - 设置画布的帧数据和对象状态
- `isAbleToChangeFrame()` - 检查是否可以切换帧
- `draw()` - 绘制图形
- `edit()` - 编辑图形
- `merge()` - 合并对象
- `split()` - 分割图形
- `group()` - 组合对象
- `join()` - 连接对象
- `slice()` - 切割图形
- `interact()` - 处理用户交互
- `configure()` - 配置画布
- `destroy()` - 销毁画布

## API CSS

- 所有绘制对象（形状、轨迹）的 ID 为 `cvat_canvas_shape_{objectState.clientID}`
- 绘制的形状和轨迹具有以下类：
  - `cvat_canvas_shape`
  - `cvat_canvas_shape_activated`
  - `cvat_canvas_shape_selection`
  - `cvat_canvas_shape_merging`
  - `cvat_canvas_shape_drawing`
  - `cvat_canvas_shape_occluded`
- 绘制的文本的类为 `cvat_canvas_text`
- 标签的类为 `cvat_canvas_tag`
- 画布图像的 ID 为 `cvat_canvas_image`
- 画布视频的 ID 为 `cvat_canvas_video`
- 绘制时的十字准线的类为 `cvat_canvas_crosshair`
- 要将元素固定到特定位置，可以使用 ID 为 `cvat_canvas_attachment_board` 的元素

## 事件

使用标准 JS 事件。

```js
    - canvas.setup
    - canvas.activated => {state: ObjectState}
    - canvas.clicked => {state: ObjectState}
    - canvas.moved => {states: ObjectState[], x: number, y: number}
    - canvas.find => {states: ObjectState[], x: number, y: number}
    - canvas.drawn => {state: DrawnData}
    - canvas.interacted => {shapes: InteractionResult[]}
    - canvas.editstart
    - canvas.edited => {state: ObjectState, points: number[], rotation?: number}
    - canvas.splitted => {state: ObjectState, frame: number, duration: number}
    - canvas.grouped => {states: ObjectState[], duration: number}
    - canvas.joined => {states: ObjectState[], points: number[], duration: number}
    - canvas.sliced => {state: ObjectState, results: number[][], duration: number}
    - canvas.merged => {states: ObjectState[], duration: number}
    - canvas.canceled
    - canvas.dragstart
    - canvas.dragstop
    - canvas.zoomstart
    - canvas.zoomstop
    - canvas.zoom
    - canvas.reshape
    - canvas.fit
    - canvas.regionselected => {points: number[]}
    - canvas.dragshape => {duration: number, state: ObjectState}
    - canvas.roiselected => {points: number[]}
    - canvas.resizeshape => {duration: number, state: ObjectState}
    - canvas.contextmenu => { mouseEvent: MouseEvent, objectState: ObjectState,  pointID: number }
    - canvas.message => { messages: { type: 'text' | 'list'; content: string | string[]; className?: string; icon?: 'info' | 'loading' }[] | null, topic: string }
    - canvas.error => { exception: Error, domain?: string }
    - canvas.destroy
```

## Web 使用示例

```ts
import { Canvas, RectDrawingMethod, CanvasMode } from 'cvmark';

const canvas = new Canvas();

// 将画布添加到 HTML 容器
container.appendChild(canvas.html());
canvas.fitCanvas();

// 使用 API
canvas.rotate(270);
canvas.draw({
  enabled: true,
  shapeType: 'rectangle',
  crosshair: true,
  rectDrawingMethod: RectDrawingMethod.CLASSIC,
});
```

## 依赖项

主要依赖项：

- fabric.js - 用于 Canvas 操作
- svg.js - 用于 SVG 操作
- svg.draw.js - 用于 SVG 绘图
- svg.draggable.js - 用于 SVG 拖拽
- svg.resize.js - 用于 SVG 调整大小
- svg.select.js - 用于 SVG 选择
- polylabel - 用于多边形标签优化

## 许可证

MIT
