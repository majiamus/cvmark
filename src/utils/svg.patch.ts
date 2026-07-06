/* eslint-disable */
import * as SVG from "svg.js"; // 轻量级的JavaScript库，提供了创建、修改和动画化SVG元素的API
import "svg.draggable.js"; // 为SVG元素添加拖拽功能，允许用户通过鼠标拖拽来移动SVG元素
import "svg.resize.js"; // 为SVG元素添加调整大小功能，允许用户通过拖拽控制点来调整SVG元素的大小
import "svg.select.js"; // 为SVG元素添加选择功能，提供选择和取消选择SVG元素的能力
import "svg.draw.js"; // 为SVG元素添加绘制功能，允许用户通过鼠标交互来绘制各种形状

// 保存原始的draw方法引用，以便后续调用和保持兼容性
const originalDraw = SVG.Element.prototype.draw;

// 重写SVG.Element原型上的draw方法，增强其功能
SVG.Element.prototype.draw = function drawHandler(...args: any): any {
  // 尝试获取已存在的绘制处理器
  let handler = this.remember("_paintHandler");

  // 如果处理器不存在，则进行初始化
  if (!handler) {
    // 调用原始的draw方法，确保基本功能正常工作
    originalDraw.call(this, ...args);

    // 再次获取处理器，因为原始方法可能已经创建了它
    handler = this.remember("_paintHandler");

    // 特殊情况处理：绘制单个点时，处理器可能立即创建和销毁；因此，我们需要检查处理程序是否仍然存在
    if (handler && !handler.set) {
      // 如果处理器存在但没有set属性，则创建一个新的SVG.Set实例；SVG.Set是SVG.js中用于管理多个元素的集合对象
      handler.set = new SVG.Set();
    }
  } else {
    // 如果处理器已存在，直接调用原始方法
    originalDraw.call(this, ...args);
  }

  // 返回当前元素，支持链式调用
  return this;
};

// 将原始方法的所有属性复制到新方法上，确保原始方法的任何附加属性或方法都不会丢失
for (const key of Object.keys(originalDraw)) {
  SVG.Element.prototype.draw[key] = originalDraw[key];
}

// 为多边形和多段线创建撤销功能
function undo(this: any): void {
  // 检查是否存在一个set对象且该集合不为空
  if (this.set && this.set.length()) {
    // 从集合中移除最后一个元素，并从DOM中删除该元素
    // splice(-1, 1)删除数组的最后一个元素并返回被删除的元素
    // [0].remove()调用被删除元素的remove()方法从DOM中移除该元素
    this.set.members.splice(-1, 1)[0].remove();

    // 从元素数组中移除最后一个点
    // this.el.array()获取元素的点数组
    // splice(-2, 1)删除倒数第二个元素（因为SVG点数组中每个点由x,y两个值组成）
    this.el.array().value.splice(-2, 1);

    // 使用更新后的点数组重新绘制元素，plot()方法根据给定的点数组重新绘制形状
    this.el.plot(this.el.array());

    // 触发一个名为'undopoint'的自定义事件，这允许其他代码监听这个事件并做出相应反应
    this.el.fire("undopoint");
  }
}

// 将撤销功能扩展到多段线(polyline)绘制插件
// 使用Object.assign创建原始插件的副本，然后添加undo方法
SVG.Element.prototype.draw.extend(
  "polyline",
  Object.assign({}, SVG.Element.prototype.draw.plugins.polyline, {
    undo: undo,
  })
);

// 将撤销功能扩展到多边形(polygon)绘制插件
// 使用Object.assign创建原始插件的副本，然后添加undo方法
SVG.Element.prototype.draw.extend(
  "polygon",
  Object.assign({}, SVG.Element.prototype.draw.plugins.polygon, {
    undo: undo,
  })
);

// 导出圆形描边颜色常量，设置为黑色
export const CIRCLE_STROKE = "#000";

// 修复drawCircles方法
// 该方法用于在绘制线条、多段线和多边形时，在每个顶点位置绘制小圆点作为视觉提示
function drawCircles(this: any): void {
  // 获取元素的点数组，valueOf()确保获取原始数组值
  const array = this.el.array().valueOf();

  // 移除所有已存在的圆点
  // 遍历当前集合中的每个元素并从DOM中移除
  this.set.each(function (this: any): void {
    this.remove();
  });

  // 清空集合，确保集合中不包含任何元素
  this.set.clear();

  // 遍历点数组，为每个点（除了最后一个）创建一个小圆点
  // array.length - 1是因为最后一个点通常是正在绘制的点，不需要固定圆点
  for (let i = 0; i < array.length - 1; ++i) {
    // 解构赋值，获取当前点的x坐标
    [this.p.x] = array[i];
    // 解构赋值，获取当前点的y坐标（使用逗号跳过第一个值）
    [, this.p.y] = array[i];

    // 进行坐标变换，将点坐标从元素坐标系转换到屏幕坐标系
    // getScreenCTM()获取元素的屏幕变换矩阵
    // inverse()获取逆矩阵，用于反向变换
    // multiply()矩阵乘法，组合变换
    const p = this.p.matrixTransform(
      this.parent.node.getScreenCTM().inverse().multiply(this.el.node.getScreenCTM())
    );

    // 在转换后的坐标位置创建一个小圆点，并添加到集合中
    this.set.add(
      this.parent
        .circle(5) // 创建半径为5的圆
        .stroke({
          // 设置描边样式
          width: 1,
          color: CIRCLE_STROKE, // 使用黑色描边
        })
        .fill("#ccc") // 设置填充色为浅灰色
        .center(p.x, p.y) // 将圆心设置在转换后的坐标位置
    );
  }
}

// 将drawCircles方法扩展到线条(line)绘制插件
// 使用Object.assign创建原始插件的副本，然后添加drawCircles方法
SVG.Element.prototype.draw.extend(
  "line",
  Object.assign({}, SVG.Element.prototype.draw.plugins.line, {
    drawCircles: drawCircles,
  })
);

// 将drawCircles方法扩展到多段线(polyline)绘制插件
// 使用Object.assign创建原始插件的副本，然后添加drawCircles方法
SVG.Element.prototype.draw.extend(
  "polyline",
  Object.assign({}, SVG.Element.prototype.draw.plugins.polyline, {
    drawCircles: drawCircles,
  })
);

// 将drawCircles方法扩展到多边形(polygon)绘制插件
// 使用Object.assign创建原始插件的副本，然后添加drawCircles方法
SVG.Element.prototype.draw.extend(
  "polygon",
  Object.assign({}, SVG.Element.prototype.draw.plugins.polygon, {
    drawCircles: drawCircles,
  })
);

// 修复拖拽方法，保存原始的draggable方法引用，以便后续调用和保持兼容性
const originalDraggable = SVG.Element.prototype.draggable;

// 重写SVG.Element原型上的draggable方法，增强其拖拽功能
SVG.Element.prototype.draggable = function draggableHandler(...args: any): any {
  // 尝试获取已存在的拖拽处理器
  let handler = this.remember("_draggable");

  // 如果处理器不存在，则进行初始化
  if (!handler) {
    // 调用原始的draggable方法，确保基本功能正常工作
    originalDraggable.call(this, ...args);

    // 再次获取处理器，因为原始方法可能已经创建了它
    handler = this.remember("_draggable");

    // 重写处理器的drag方法，增强拖拽行为
    handler.drag = function (e: any) {
      // 获取元素的屏幕变换矩阵的逆矩阵，用于坐标转换
      // 这确保了拖拽时的坐标计算是正确的，特别是在有变换的情况下
      this.m = this.el.node.getScreenCTM().inverse();

      // 调用原始处理器的drag方法，确保基本拖拽功能正常工作
      return handler.constructor.prototype.drag.call(this, e);
    };
  } else {
    // 如果处理器已存在，直接调用原始方法
    originalDraggable.call(this, ...args);
  }

  // 返回当前元素，支持链式调用
  return this;
};

// 将原始方法的所有属性复制到新方法上，确保原始方法的任何附加属性或方法都不会丢失
for (const key of Object.keys(originalDraggable)) {
  SVG.Element.prototype.draggable[key] = originalDraggable[key];
}

// 修复调整大小方法，保存原始的resize方法引用，以便后续调用和保持兼容性
const originalResize = SVG.Element.prototype.resize;

// 重写SVG.Element原型上的resize方法，增强其调整大小功能
SVG.Element.prototype.resize = function resizeHandler(...args: any): any {
  // 尝试获取已存在的调整大小处理器
  let handler = this.remember("_resizeHandler");

  // 如果处理器不存在，则进行初始化
  if (!handler) {
    // 调用原始的resize方法，确保基本功能正常工作
    originalResize.call(this, ...args);

    // 再次获取处理器，因为原始方法可能已经创建了它
    handler = this.remember("_resizeHandler");

    // 重写处理器的resize方法，增强调整大小行为
    handler.resize = function (e: any) {
      // 从事件详情中提取原始DOM事件
      const { event } = e.detail;

      // 检查是否按下了旋转点（事件类型为"rot"表示旋转操作）
      this.rotationPointPressed = e.type === "rot";

      // 检查是否应该执行调整大小操作
      if (
        event.button === 0 && // 只响应左键点击
        (!event.shiftKey ||
          this.el.parent().hasClass("cvat_canvas_shape_cuboid") ||
          this.el.type === "rect") && // 忽略Shift键，对于立方体（改变透视）和矩形（精确旋转）
        !event.altKey // 不响应Alt键
      ) {
        // 调用原始处理器的resize方法，确保基本调整大小功能正常工作
        return handler.constructor.prototype.resize.call(this, e);
      }
    };

    // 重写处理器的update方法，增强更新行为
    handler.update = function (e: any) {
      // 如果不是在旋转操作中，则更新变换矩阵
      if (!this.rotationPointPressed) {
        // 获取元素的屏幕变换矩阵的逆矩阵，用于坐标转换
        // 这确保了调整大小时的坐标计算是正确的，特别是在有变换的情况下
        this.m = this.el.node.getScreenCTM().inverse();
      }

      // 调用原始处理器的update方法，确保基本更新功能正常工作
      handler.constructor.prototype.update.call(this, e);
    };
  } else {
    // 如果处理器已存在，直接调用原始方法
    originalResize.call(this, ...args);
  }

  // 返回当前元素，支持链式调用
  return this;
};

// 将原始方法的所有属性复制到新方法上，确保原始方法的任何附加属性或方法都不会丢失
for (const key of Object.keys(originalResize)) {
  SVG.Element.prototype.resize[key] = originalResize[key];
}
