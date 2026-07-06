// Copyright (C) 2020-2022 Intel Corporation
//
// SPDX-License-Identifier: MIT

import type * as SVG from "svg.js";

import consts from "../consts/consts";
import type { Configuration, Geometry } from "../core/canvasModel";

/**
 * 表示转换后的形状，包含点坐标和颜色信息
 */
interface TransformedShape {
  /** 形状的点坐标字符串，格式为"x1,y1 x2,y2 ..." */
  points: string;
  /** 形状的填充颜色 */
  color: string;
}

/**
 * 自动边界处理器接口，用于处理形状之间的自动边界连接
 */
export interface AutoborderHandler {
  /**
   * 启用或禁用自动边界功能
   * @param enabled - 是否启用自动边界功能
   * @param currentShape - 当前正在编辑的形状
   * @param currentID - 当前形状的ID
   */
  autoborder(enabled: boolean, currentShape?: SVG.Shape, currentID?: number): void;

  /**
   * 配置自动边界处理器的参数
   * @param configuration - 配置对象，包含控制点大小等参数
   */
  configure(configuration: Configuration): void;

  /**
   * 根据几何变换更新处理器的缩放比例
   * @param geometry - 几何变换对象，包含缩放信息
   */
  transform(geometry: Geometry): void;

  /**
   * 更新画布上的形状对象，重新绘制标记点
   */
  updateObjects(): void;
}

/**
 * 自动边界处理器的实现类
 * 提供在形状之间自动创建边界连接的功能，通过点击现有形状上的点来创建新形状
 */
export class AutoborderHandlerImpl implements AutoborderHandler {
  /** 当前正在编辑的形状 */
  private currentShape: SVG.Shape | null;
  /** 当前形状的ID */
  private currentID?: number;
  /** 包含所有形状的SVG元素 */
  private frameContent: SVGSVGElement;
  /** 自动边界功能是否启用 */
  private enabled: boolean;
  /** 当前缩放比例 */
  private scale: number;
  /** 控制点的大小 */
  private controlPointsSize: number;
  /** 包含所有标记点组的数组 */
  private groups: SVGGElement[];
  /** 当前辅助形状组的ID */
  private auxiliaryGroupID: number | null;
  /** 辅助点击点的ID数组 */
  private auxiliaryClicks: number[];
  /** 事件监听器映射表 */
  private listeners: Record<
    number,
    Record<
      number,
      {
        click: (event: MouseEvent) => void;
        dblclick: (event: MouseEvent) => void;
      }
    >
  >;

  /**
   * 创建自动边界处理器实例
   * @param frameContent - 包含所有形状的SVG元素
   */
  public constructor(frameContent: SVGSVGElement) {
    this.frameContent = frameContent;
    this.currentID = undefined;
    this.currentShape = null;
    this.enabled = false;
    this.scale = 1;
    this.groups = [];
    this.controlPointsSize = consts.BASE_POINT_SIZE;
    this.auxiliaryGroupID = null;
    this.auxiliaryClicks = [];
    this.listeners = {};
  }

  /**
   * 移除所有标记点和相关事件监听器
   */
  private removeMarkers(): void {
    // 遍历所有标记点组
    this.groups.forEach((group: SVGGElement): void => {
      // 获取当前组的ID
      const groupID = group.dataset.groupId;
      // 遍历组中的所有圆形标记点
      Array.from(group.children).forEach(
        (circleElement: Element, pointID: number): void => {
          const circle = circleElement as SVGCircleElement;
          if (groupID !== undefined) {
            // 移除点击事件监听器
            circle.removeEventListener("click", this.listeners[+groupID][pointID].click);
            // 移除双击事件监听器
            circle.removeEventListener(
              "dblclick",
              this.listeners[+groupID][pointID].click
            );
          }
          // 从DOM中移除圆形元素
          circle.remove();
        }
      );

      // 从DOM中移除整个组
      group.remove();
    });

    // 重置所有内部状态
    this.groups = []; // 清空组数组
    this.auxiliaryGroupID = null; // 重置辅助组ID
    this.auxiliaryClicks = []; // 清空辅助点击点数组
    this.listeners = {}; // 清空事件监听器映射表
  }

  /**
   * 释放资源，禁用自动边界功能
   */
  private release(): void {
    // 移除所有标记点和相关事件监听器
    this.removeMarkers();
    // 禁用自动边界功能
    this.enabled = false;
    // 清除当前形状引用
    this.currentShape = null;
  }

  /**
   * 向当前形状添加一个点
   * @param x - 点的X坐标
   * @param y - 点的Y坐标
   */
  private addPointToCurrentShape(x: number, y: number): void {
    // 获取当前形状的点数组
    const array: number[][] = (this.currentShape as any).array().valueOf();
    // 移除数组的最后一个元素（可能是重复的结束点）
    array.pop();

    // 需要添加两次（特定库的要求）
    array.push([x, y]);
    array.push([x, y]);

    // 获取形状的绘制处理器
    const paintHandler = this.currentShape?.remember("_paintHandler");
    // 重新绘制所有圆形标记点
    paintHandler.drawCircles();
    // 调整所有圆形标记点的样式以适应当前缩放比例
    paintHandler.set.members.forEach((el: SVG.Circle): void => {
      el.attr("stroke-width", 1 / this.scale).attr("r", 2.5 / this.scale);
    });
    // 更新形状的路径点
    (this.currentShape as any).plot(array);
  }

  /**
   * 重置辅助形状，清除所有辅助点击点和样式
   */
  private resetAuxiliaryShape(): void {
    // 检查是否存在辅助组ID
    if (this.auxiliaryGroupID !== null) {
      // 遍历所有辅助点击点
      while (this.auxiliaryClicks.length > 0) {
        // 获取要重置的点ID
        const resetID = this.auxiliaryClicks.pop();
        if (resetID !== undefined) {
          // 移除该点的方向样式类
          this.groups[this.auxiliaryGroupID].children[resetID].classList.remove(
            "cvat_canvas_autoborder_point_direction"
          );
        }
      }
    }

    // 清空辅助点击点数组
    this.auxiliaryClicks = [];
    // 重置辅助组ID
    this.auxiliaryGroupID = null;
  }

  /**
   * 绘制标记点，创建可交互的控制点
   * @param transformedShapes - 变换后的形状数组
   */
  private drawMarkers(transformedShapes: TransformedShape[]): void {
    // SVG命名空间
    const svgNamespace = "http://www.w3.org/2000/svg";

    // 为每个形状创建一个组，包含所有控制点
    this.groups = transformedShapes.map(
      (shape: TransformedShape, groupID: number): SVGGElement => {
        // 创建SVG组元素
        const group = document.createElementNS(svgNamespace, "g");
        // 设置组ID属性
        group.setAttribute("data-group-id", `${groupID}`);

        // 初始化该组的事件监听器对象
        this.listeners[groupID] = this.listeners[groupID] || {};
        // 为形状的每个点创建圆形控制点
        const circles = shape.points
          .split(/\s/)
          .map((point: string, pointID: number, points: string[]): SVGCircleElement => {
            // 解析点的坐标
            const [x, y] = point.split(",");

            // 创建圆形元素
            const circle = document.createElementNS(svgNamespace, "circle");
            // 添加样式类
            circle.classList.add("cvat_canvas_autoborder_point");
            // 设置圆形属性
            circle.setAttribute("fill", shape.color);
            circle.setAttribute("stroke", "black");
            circle.setAttribute(
              "stroke-width",
              `${consts.POINTS_STROKE_WIDTH / this.scale}`
            );
            circle.setAttribute("cx", x);
            circle.setAttribute("cy", y);
            circle.setAttribute("r", `${this.controlPointsSize / this.scale}`);

            // 定义点击事件处理函数
            const click = (event: MouseEvent): void => {
              // 阻止事件冒泡
              event.stopPropagation();

              // 如果点击了另一个形状，重置辅助形状
              if (this.auxiliaryGroupID !== null && this.auxiliaryGroupID !== groupID) {
                this.resetAuxiliaryShape();
              }

              // 设置当前辅助组ID
              this.auxiliaryGroupID = groupID;
              // 将点击的组置于顶层
              this.frameContent.appendChild(group);

              // 如果第二个点被点击了两次
              if (this.auxiliaryClicks[1] === pointID) {
                // 添加点到当前形状并重置辅助形状
                this.addPointToCurrentShape(+x, +y);
                this.resetAuxiliaryShape();
                return;
              }

              // 第一个点不能被点击两次，如果是则忽略
              if (this.auxiliaryClicks[0] !== pointID) {
                this.auxiliaryClicks.push(pointID);
              } else {
                return;
              }

              // 第一次点击处理
              if (this.auxiliaryClicks.length === 1) {
                const handler = this.currentShape?.remember("_paintHandler");
                // 绘制并移除初始点，只是为了初始化数据结构
                if (!handler || !handler.startPoint) {
                  (this.currentShape as any).draw("point", event);
                  (this.currentShape as any).draw("undo");
                }

                // 添加点到当前形状
                this.addPointToCurrentShape(+x, +y);
                // 第二次点击处理
              } else if (this.auxiliaryClicks.length === 2) {
                // 添加方向样式类
                circle.classList.add("cvat_canvas_autoborder_point_direction");
                // 第三次及以后点击处理
              } else {
                // 计算绕行方向的符号
                const landmarks = this.auxiliaryClicks;
                const sign =
                  Math.sign(landmarks[2] - landmarks[0]) *
                  Math.sign(landmarks[1] - landmarks[0]) *
                  Math.sign(landmarks[2] - landmarks[1]);

                // 遍历多边形并获取顶点
                // 第一个顶点已经被绘制
                const way = [];
                for (let i = landmarks[0] + sign; ; i += sign) {
                  // 处理循环索引
                  if (i < 0) {
                    i = points.length - 1;
                  } else if (i === points.length) {
                    i = 0;
                  }

                  // 添加点到路径
                  way.push(points[i]);

                  // 如果到达最后一个点，停止循环
                  if (i === this.auxiliaryClicks[this.auxiliaryClicks.length - 1]) {
                    // 最后一个元素添加两次
                    // svg.draw.js的特定要求
                    // way.push(points[i]);
                    break;
                  }
                }

                // 将路径中的所有点添加到当前形状
                for (const wayPoint of way) {
                  const [pX, pY] = wayPoint
                    .split(",")
                    .map((coordinate: string): number => +coordinate);
                  this.addPointToCurrentShape(pX, pY);
                }

                // 重置辅助形状
                this.resetAuxiliaryShape();
              }
            };

            // 定义双击事件处理函数
            const dblclick = (event: MouseEvent): void => {
              // 阻止事件冒泡
              event.stopPropagation();
            };

            // 保存事件监听器引用
            this.listeners[groupID][pointID] = {
              click,
              dblclick,
            };

            // 添加事件监听器
            circle.addEventListener("mousedown", this.listeners[groupID][pointID].click);
            circle.addEventListener("dblclick", this.listeners[groupID][pointID].click);
            return circle;
          });

        // 将所有圆形元素添加到组中
        group.append(...circles);
        return group;
      }
    );

    // 将所有组添加到框架内容中
    this.frameContent.append(...this.groups);
  }

  /**
   * 更新画布上的形状对象，重新绘制标记点
   */
  public updateObjects(): void {
    // 如果自动边界功能未启用，直接返回
    if (!this.enabled) return;
    // 移除所有现有的标记点
    this.removeMarkers();

    // 获取当前形状的客户端ID
    const currentClientID = this.currentShape?.node.dataset.originClientId;
    // 获取所有可见的形状（排除当前形状和隐藏形状）
    const shapes = Array.from(
      this.frameContent.getElementsByClassName("cvat_canvas_shape")
    ).filter((shapeElement: Element): boolean => {
      const shape = shapeElement as HTMLElement;
      const clientID = shape.getAttribute("clientID");
      return (
        clientID !== null &&
        +clientID !== this.currentID &&
        !shape.classList.contains("cvat_canvas_hidden")
      );
    });
    // 将形状转换为变换后的形状对象
    const transformedShapes = shapes
      .map((shapeElement: Element): TransformedShape | null => {
        const shape = shapeElement as HTMLElement;
        // 获取形状的颜色和客户端ID
        const color = shape.getAttribute("fill");
        const clientID = shape.getAttribute("clientID");

        // 如果缺少必要属性，返回null
        if (color === null || clientID === null) return null;
        // 如果是当前形状，返回null
        if (+clientID === +currentClientID!) {
          return null;
        }

        let points = "";
        // 根据形状类型提取点数据
        if (shape.tagName === "polyline" || shape.tagName === "polygon") {
          // 多边形或折线形状
          points = shape.getAttribute("points")!;
        } else if (shape.tagName === "ellipse") {
          // 椭圆形状，提取中心点
          const cx = +shape.getAttribute("cx")!;
          const cy = +shape.getAttribute("cy")!;
          points = `${cx},${cy}`;
        } else if (shape.tagName === "rect") {
          // 矩形形状，提取四个角点
          const x = +shape.getAttribute("x")!;
          const y = +shape.getAttribute("y")!;
          const width = +shape.getAttribute("width")!;
          const height = +shape.getAttribute("height")!;

          // 检查数值是否有效
          if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(x) || Number.isNaN(x)) {
            return null;
          }

          // 构建矩形四个角点的坐标字符串
          points = `${x},${y} ${x + width},${y} ${x + width},${y + height} ${x},${y + height}`;
        } else if (shape.tagName === "g") {
          // 组形状，获取内部的折线数据
          const polylineID = shape.dataset.polylineId;
          const polyline = this.frameContent.getElementById(polylineID!);
          if (polyline && polyline.getAttribute("points")) {
            points = polyline.getAttribute("points")!;
          } else {
            return null;
          }
        }

        // 返回变换后的形状对象
        return {
          color,
          points: points.trim(),
        };
      })
      // 过滤掉null值
      .filter((state): state is TransformedShape => state !== null);

    // 为变换后的形状绘制标记点
    this.drawMarkers(transformedShapes);
  }

  /**
   * 启用或禁用自动边界功能
   * @param enabled - 是否启用自动边界功能
   * @param currentShape - 当前形状对象
   * @param currentID - 当前形状的ID
   */
  public autoborder(
    enabled: boolean,
    currentShape?: SVG.Shape,
    currentID?: number
  ): void {
    // 如果请求启用功能且当前未启用且提供了形状对象
    if (enabled && !this.enabled && currentShape) {
      // 设置启用状态
      this.enabled = true;
      // 保存当前形状引用
      this.currentShape = currentShape;
      // 保存当前形状ID
      this.currentID = currentID;
      // 更新对象并绘制标记点
      this.updateObjects();
    } else {
      // 否则释放资源并禁用功能
      this.release();
    }
  }

  /**
   * 根据几何变换更新标记点的缩放比例
   * @param geometry - 包含缩放信息的几何对象
   */
  public transform(geometry: Geometry): void {
    // 更新缩放比例
    this.scale = geometry.scale;
    // 遍历所有标记点组
    this.groups.forEach((group: SVGGElement): void => {
      // 遍历组内的所有圆形标记点
      Array.from(group.children).forEach((circleElement: Element): void => {
        const circle = circleElement as SVGCircleElement;
        // 根据缩放比例调整圆形半径
        circle.setAttribute("r", `${this.controlPointsSize / this.scale}`);
        // 根据缩放比例调整边框宽度
        circle.setAttribute("stroke-width", `${consts.BASE_STROKE_WIDTH / this.scale}`);
      });
    });
  }

  /**
   * 配置自动边界处理器的参数
   * @param configuration - 包含控制点大小等配置的对象
   */
  public configure(configuration: Configuration): void {
    // 设置控制点大小，如果未提供则使用默认值
    this.controlPointsSize = configuration.controlPointsSize || consts.BASE_POINT_SIZE;
  }
}
