// Copyright (C) 2019-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type * as SVG from "svg.js";

import "svg.draw.js";

import Crosshair from "../componets/crosshair";
import consts from "../consts/consts";
import {
  type Configuration,
  type DrawData,
  type Geometry,
  RectDrawingMethod,
} from "../core/canvasModel";
import {
  type BBox,
  type Box,
  clamp,
  computeWrappingBox,
  displayShapeSize,
  intersection,
  makeSVGFromTemplate,
  type Point,
  readPointsFromShape,
  type ShapeSizeElement,
  setupSkeletonEdges,
  stringifyPoints,
  translateFromCanvas,
  translateToCanvas,
  translateToSVG,
} from "../utils/shared";
import { CIRCLE_STROKE } from "../utils/svg.patch";

import type { AutoborderHandler } from "./autoborderHandler";

/**
 * 绘制处理器接口，定义了绘制形状的基本操作
 */
export interface DrawHandler {
  /**
   * 配置绘制处理器的参数
   * @param configuration - 包含绘制配置的对象
   */
  configure(configuration: Configuration): void;

  /**
   * 在画布上绘制形状
   * @param drawData - 包含绘制数据的对象
   * @param geometry - 包含几何变换信息的对象
   */
  draw(drawData: DrawData, geometry: Geometry): void;

  /**
   * 根据几何变换更新已绘制的形状
   * @param geometry - 包含几何变换信息的对象
   */
  transform(geometry: Geometry): void;

  /**
   * 取消当前绘制操作并清理资源
   */
  cancel(): void;
}

/**
 * 最终坐标接口，包含形状的点数组和边界框信息
 */
interface FinalCoordinates {
  /** 形状的点坐标数组 */
  points: number[];
  /** 形状的边界框 */
  box: Box;
}

/**
 * 检查形状是否符合约束条件
 * @param shapeType - 形状类型（矩形、多边形、折线等）
 * @param points - 形状的点坐标数组
 * @param box - 形状的边界框，可选参数
 * @returns 如果形状符合约束条件返回true，否则返回false
 */
function checkConstraint(
  shapeType: string,
  points: number[],
  box: Box | null = null
): boolean {
  // 检查矩形形状的约束条件
  if (shapeType === "rectangle") {
    // 解构获取矩形的左上角和右下角坐标
    const [xtl, ytl, xbr, ybr] = points;
    // 计算矩形的宽度和高度
    const [width, height] = [xbr - xtl, ybr - ytl];
    // 矩形必须同时满足最小宽度和最小高度要求
    return width >= consts.SIZE_THRESHOLD && height >= consts.SIZE_THRESHOLD;
  }

  // 检查多边形形状的约束条件
  if (shapeType === "polygon") {
    // 计算多边形的宽度和高度
    const [width, height] = [box!.xbr - box!.xtl, box!.ybr - box!.ytl];
    // 多边形必须满足宽度或高度要求，且至少有3个点（6个坐标值）
    return (
      (width >= consts.SIZE_THRESHOLD || height > consts.SIZE_THRESHOLD) &&
      points.length >= 3 * 2
    );
  }

  // 检查折线形状的约束条件
  if (shapeType === "polyline") {
    // 计算折线的宽度和高度
    const [width, height] = [box!.xbr - box!.xtl, box!.ybr - box!.ytl];
    // 折线必须满足宽度或高度要求，且至少有2个点（4个坐标值）
    return (
      (width >= consts.SIZE_THRESHOLD || height >= consts.SIZE_THRESHOLD) &&
      points.length >= 2 * 2
    );
  }

  // 检查点集形状的约束条件
  if (shapeType === "points") {
    // 点集可以是多个点，或者是单个非原点
    return (
      points.length > 2 || (points.length === 2 && points[0] !== 0 && points[1] !== 0)
    );
  }

  // 检查椭圆形状的约束条件
  if (shapeType === "ellipse") {
    // 椭圆点数组格式为 [cx, cy, rx, ry]，计算实际宽度和高度
    const [width, height] = [(points[2] - points[0]) * 2, (points[1] - points[3]) * 2];
    // 椭圆必须同时满足最小宽度和最小高度要求
    return width >= consts.SIZE_THRESHOLD && height > consts.SIZE_THRESHOLD;
  }

  // 检查立方体形状的约束条件
  if (shapeType === "cuboid") {
    // 立方体可以是4个点（前面）、8个点（完整）或2个点（最小矩形）
    return (
      points.length === 4 * 2 ||
      points.length === 8 * 2 ||
      (points.length === 2 * 2 &&
        points[2] - points[0] >= consts.SIZE_THRESHOLD &&
        points[3] - points[1] >= consts.SIZE_THRESHOLD)
    );
  }

  // 检查骨架形状的约束条件
  if (shapeType === "skeleton") {
    // 解构获取骨架的边界坐标
    const [xtl, ytl, xbr, ybr] = points;
    // 计算骨架的宽度和高度
    const [width, height] = [xbr - xtl, ybr - ytl];
    // 骨架只需满足宽度或高度要求之一
    return width >= consts.SIZE_THRESHOLD || height >= consts.SIZE_THRESHOLD;
  }

  // 未知形状类型，不符合约束条件
  return false;
}

export class DrawHandlerImpl implements DrawHandler {
  /**
   * 绘制完成回调函数，用于通知创建新形状
   * @param data - 形状数据对象
   * @param duration - 绘制持续时间（可选）
   * @param continueDraw - 是否继续绘制（可选）
   * @param prevDrawData - 上一次绘制数据（可选）
   */
  private onDrawDoneDefault: (
    data: object | null,
    duration?: number,
    continueDraw?: boolean,
    prevDrawData?: DrawData
  ) => void;

  /** 绘制开始时间戳，用于计算绘制持续时间 */
  private startTimestamp: number;

  /** SVG画布容器，用于绘制形状 */
  private canvas: SVG.Container;

  /** 文本容器，用于显示形状尺寸等信息 */
  private text: SVG.Container;

  /** 当前光标位置坐标 */
  private cursorPosition: {
    x: number;
    y: number;
  };

  /** 十字准线对象，用于辅助绘制 */
  private crosshair: Crosshair;

  /** 当前绘制数据，包含形状类型、状态等信息 */
  private drawData: DrawData | null;

  /** 几何变换信息，包含缩放比例等 */
  private geometry: Geometry;

  /** 自动边界处理器，用于处理形状边界 */
  private autoborderHandler: AutoborderHandler;

  /** 自动边界功能是否启用 */
  private autobordersEnabled: boolean;

  /** 控制点大小，用于调整形状控制点的显示大小 */
  private controlPointsSize: number;

  /** 选中形状的不透明度 */
  private selectedShapeOpacity: number;

  /** 轮廓边框样式 */
  private outlinedBorders: string;

  /** 绘制器是否隐藏 */
  private isHidden: boolean;

  /**
   * 绘制实例对象，使用any类型是因为SVG插件无法更改声明的接口
   * 因此像draw()这样的方法在SVG.Shape中是未定义的，但实际上它们存在
   */
  private drawInstance: any;

  /** 绘制器是否已初始化 */
  private initialized: boolean;

  /** 绘制操作是否已取消 */
  private canceled: boolean;

  /** 点组容器，用于管理绘制过程中的点 */
  private pointsGroup: SVG.G | null;

  /** 形状尺寸显示元素，用于显示形状的尺寸信息 */
  private shapeSizeElement: ShapeSizeElement | null;

  /**
   * 计算椭圆形状的最终坐标
   * @param points 原始点坐标数组 [中心X, 中心Y, 右边缘X, 上边缘Y]
   * @param fitIntoFrame 是否将椭圆限制在图像框架内
   * @returns 调整后的椭圆坐标数组 [中心X, 中心Y, 右边缘X, 上边缘Y]
   */
  private getFinalEllipseCoordinates(points: number[], fitIntoFrame: boolean): number[] {
    // 获取几何偏移量，用于将全局坐标转换为相对于图像的坐标
    const { offset } = this.geometry;
    // 将所有点坐标减去偏移量，转换为相对于图像的坐标
    const [cx, cy, rightX, topY] = points.map((coord: number) => coord - offset);
    // 计算椭圆的水平和垂直半径
    const [rx, ry] = [rightX - cx, cy - topY];
    // 获取图像框架的宽度和高度
    const frameWidth = this.geometry.image.width;
    const frameHeight = this.geometry.image.height;
    // 如果需要将椭圆限制在框架内，调整中心点和半径
    const [fitCX, fitCY] = fitIntoFrame
      ? [clamp(cx, 0, frameWidth), clamp(cy, 0, frameHeight)]
      : [cx, cy];
    // 确保椭圆不会超出框架边界，调整半径大小
    const [fitRX, fitRY] = fitIntoFrame
      ? [Math.min(rx, frameWidth - cx, cx), Math.min(ry, frameHeight - cy, cy)]
      : [rx, ry];
    // 返回调整后的椭圆坐标
    return [fitCX, fitCY, fitCX + fitRX, fitCY - fitRY];
  }

  /**
   * 计算矩形形状的最终坐标
   * @param points 原始点坐标数组 [左上角X, 左上角Y, 右下角X, 右下角Y]
   * @param fitIntoFrame 是否将矩形限制在图像框架内
   * @returns 调整后的矩形坐标数组 [左上角X, 左上角Y, 右下角X, 右下角Y]
   */
  private getFinalRectCoordinates(points: number[], fitIntoFrame: boolean): number[] {
    // 获取图像框架的宽度和高度
    const frameWidth = this.geometry.image.width;
    const frameHeight = this.geometry.image.height;
    // 获取几何偏移量，用于将全局坐标转换为相对于图像的坐标
    const { offset } = this.geometry;

    // 将所有点坐标减去偏移量，转换为相对于图像的坐标
    let [xtl, ytl, xbr, ybr] = points.map((coord: number): number => coord - offset);

    // 如果需要将矩形限制在框架内，调整坐标确保不超出边界
    if (fitIntoFrame) {
      xtl = Math.min(Math.max(xtl, 0), frameWidth);
      xbr = Math.min(Math.max(xbr, 0), frameWidth);
      ytl = Math.min(Math.max(ytl, 0), frameHeight);
      ybr = Math.min(Math.max(ybr, 0), frameHeight);
    }

    // 返回调整后的矩形坐标
    return [xtl, ytl, xbr, ybr];
  }

  /**
   * 计算多边形或折线形状的最终坐标
   * @param targetPoints 原始点坐标数组 [x1, y1, x2, y2, ...]
   * @param fitIntoFrame 是否将形状限制在图像框架内
   * @returns 包含调整后点坐标和边界框的对象
   */
  private getFinalPolyshapeCoordinates(
    targetPoints: number[],
    fitIntoFrame: boolean
  ): FinalCoordinates {
    // 获取几何偏移量，用于将全局坐标转换为相对于图像的坐标
    const { offset } = this.geometry;
    // 将所有点坐标减去偏移量，转换为相对于图像的坐标
    let points = targetPoints.map((coord: number): number => coord - offset);
    // 初始化边界框对象，用于存储形状的最小和最大坐标
    const box = {
      xtl: Number.MAX_SAFE_INTEGER,
      ytl: Number.MAX_SAFE_INTEGER,
      xbr: Number.MIN_SAFE_INTEGER,
      ybr: Number.MIN_SAFE_INTEGER,
    };

    // 获取图像框架的宽度和高度
    const frameWidth = this.geometry.image.width;
    const frameHeight = this.geometry.image.height;

    // 定义方向枚举，用于裁剪操作
    enum Direction {
      Horizontal,
      Vertical,
    }

    // 辅助函数：检查一个值是否在两个值之间
    function isBetween(x1: number, x2: number, c: number): boolean {
      return c >= Math.min(x1, x2) && c <= Math.max(x1, x2);
    }

    // 检查点是否在框架内
    const isInsideFrame = (p: Point, direction: Direction): boolean => {
      if (direction === Direction.Horizontal) {
        return isBetween(0, frameWidth, p.x);
      }
      return isBetween(0, frameHeight, p.y);
    };

    // 计算两条线段的交点
    const findInersection = (p1: Point, p2: Point, p3: Point, p4: Point): number[] => {
      // 使用intersection函数计算两条线段的交点
      const intersectionPoint = intersection(p1, p2, p3, p4);
      // 检查交点是否存在且在两条线段上
      if (
        intersectionPoint &&
        isBetween(p1.x, p2.x, intersectionPoint.x) &&
        isBetween(p1.y, p2.y, intersectionPoint.y)
      ) {
        // 返回交点的坐标
        return [intersectionPoint.x, intersectionPoint.y];
      }
      // 如果没有有效交点，返回空数组
      return [];
    };

    // 查找线段与框架边界的交点
    const findIntersectionsWithFrameBorders = (
      p1: Point,
      p2: Point,
      direction: Direction
    ): number[] => {
      const resultPoints = [];
      // 定义框架的四条边
      const leftLine = [
        { x: 0, y: 0 },
        { x: 0, y: frameHeight },
      ];
      const topLine = [
        { x: frameWidth, y: 0 },
        { x: 0, y: 0 },
      ];
      const rightLine = [
        { x: frameWidth, y: frameHeight },
        { x: frameWidth, y: 0 },
      ];
      const bottomLine = [
        { x: 0, y: frameHeight },
        { x: frameWidth, y: frameHeight },
      ];

      // 根据方向查找与相应边界的交点
      if (direction === Direction.Horizontal) {
        resultPoints.push(...findInersection(p1, p2, leftLine[0], leftLine[1]));
        resultPoints.push(...findInersection(p1, p2, rightLine[0], rightLine[1]));
      } else {
        resultPoints.push(...findInersection(p1, p2, bottomLine[0], bottomLine[1]));
        resultPoints.push(...findInersection(p1, p2, topLine[0], topLine[1]));
      }

      // 如果找到4个交点（线段穿过整个框架），需要重新排序
      if (resultPoints.length === 4) {
        if (
          (p1.x === p2.x ||
            Math.sign(resultPoints[0] - resultPoints[2]) !== Math.sign(p1.x - p2.x)) &&
          (p1.y === p2.y ||
            Math.sign(resultPoints[1] - resultPoints[3]) !== Math.sign(p1.y - p2.y))
        ) {
          [resultPoints[0], resultPoints[2]] = [resultPoints[2], resultPoints[0]];
          [resultPoints[1], resultPoints[3]] = [resultPoints[3], resultPoints[1]];
        }
      }
      return resultPoints;
    };

    // 裁剪形状，确保在框架内
    const crop = (shapePoints: number[], direction: Direction): number[] => {
      const resultPoints = [];
      const isPolyline = this.drawData!.shapeType === "polyline";
      const isPolygon = this.drawData!.shapeType === "polygon";

      // 遍历形状的所有点
      for (let i = 0; i < shapePoints.length - 1; i += 2) {
        const curPoint = { x: shapePoints[i], y: shapePoints[i + 1] };
        // 如果当前点在框架内，则保留
        if (isInsideFrame(curPoint, direction)) {
          resultPoints.push(shapePoints[i], shapePoints[i + 1]);
        }
        // 检查是否为最后一个点
        const isLastPoint = i === shapePoints.length - 2;
        // 对于折线或只有两个点的多边形，不处理闭合
        if (isLastPoint && (isPolyline || (isPolygon && shapePoints.length === 4))) {
          break;
        }
        // 获取下一个点（对于多边形，最后一个点连接到第一个点）
        const nextPoint = isLastPoint
          ? { x: shapePoints[0], y: shapePoints[1] }
          : { x: shapePoints[i + 2], y: shapePoints[i + 3] };
        // 查找当前线段与框架边界的交点
        const intersectionPoints = findIntersectionsWithFrameBorders(
          curPoint,
          nextPoint,
          direction
        );
        if (intersectionPoints.length !== 0) {
          resultPoints.push(...intersectionPoints);
        }
      }
      return resultPoints;
    };

    // 如果需要将形状限制在框架内，则进行水平和垂直方向的裁剪
    if (fitIntoFrame) {
      points = crop(points, Direction.Horizontal);
      points = crop(points, Direction.Vertical);
    }

    // 计算形状的边界框
    for (let i = 0; i < points.length - 1; i += 2) {
      box.xtl = Math.min(box.xtl, points[i]);
      box.ytl = Math.min(box.ytl, points[i + 1]);
      box.xbr = Math.max(box.xbr, points[i]);
      box.ybr = Math.max(box.ybr, points[i + 1]);
    }

    // 返回调整后的点坐标和边界框
    return {
      points,
      box,
    };
  }

  /**
   * 计算立方体形状的最终坐标
   * @param targetPoints 原始点坐标数组
   * @returns 包含调整后点坐标和边界框的对象
   */
  private getFinalCuboidCoordinates(targetPoints: number[]): FinalCoordinates {
    // 获取几何偏移量
    const { offset } = this.geometry;
    let points = targetPoints;

    // 初始化边界框对象
    const box = {
      xtl: Number.MAX_SAFE_INTEGER,
      ytl: Number.MAX_SAFE_INTEGER,
      xbr: Number.MIN_SAFE_INTEGER,
      ybr: Number.MIN_SAFE_INTEGER,
    };

    // 获取图像框架的尺寸
    const frameWidth = this.geometry.image.width;
    const frameHeight = this.geometry.image.height;

    // 用于存储每个点需要的偏移量
    const cuboidOffsets = [];
    // 找到最小的偏移量，用于移动整个立方体
    const minCuboidOffset = {
      d: Number.MAX_SAFE_INTEGER,
      dx: 0,
      dy: 0,
    };

    // 遍历所有点，检查哪些点在框架外
    for (let i = 0; i < points.length - 1; i += 2) {
      const [x, y] = points.slice(i);

      // 如果点已经在框架内，跳过
      if (
        x >= offset &&
        x <= offset + frameWidth &&
        y >= offset &&
        y <= offset + frameHeight
      )
        continue;

      // 计算点需要移动的距离才能进入框架
      let xOffset = 0;
      let yOffset = 0;

      if (x < offset) {
        xOffset = offset - x;
      } else if (x > offset + frameWidth) {
        xOffset = offset + frameWidth - x;
      }

      if (y < offset) {
        yOffset = offset - y;
      } else if (y > offset + frameHeight) {
        yOffset = offset + frameHeight - y;
      }

      cuboidOffsets.push([xOffset, yOffset]);
    }

    // 如果所有点都在框架外，找到最小的偏移量
    if (cuboidOffsets.length === points.length / 2) {
      cuboidOffsets.forEach((offsetCoords: number[]): void => {
        const dx = offsetCoords[0] ** 2;
        const dy = offsetCoords[1] ** 2;
        // 计算欧几里得距离
        if (Math.sqrt(dx + dy) < minCuboidOffset.d) {
          minCuboidOffset.d = Math.sqrt(dx + dy);
          [minCuboidOffset.dx, minCuboidOffset.dy] = offsetCoords;
        }
      });

      // 应用最小偏移量到所有点
      points = points.map((coord: number, i: number): number => {
        if (i % 2) {
          return coord + minCuboidOffset.dy;
        }
        return coord + minCuboidOffset.dx;
      });
    }

    // 计算立方体的边界框
    points.forEach((coord: number, i: number): number => {
      if (i % 2 === 0) {
        box.xtl = Math.min(box.xtl, coord);
        box.xbr = Math.max(box.xbr, coord);
      } else {
        box.ytl = Math.min(box.ytl, coord);
        box.ybr = Math.max(box.ybr, coord);
      }

      return coord;
    });

    // 返回调整后的点坐标（减去偏移量）和边界框
    return {
      points: points.map((coord: number): number => coord - offset),
      box,
    };
  }

  /**
   * 在画布上显示十字准线
   * 根据当前光标位置和几何缩放比例显示十字准线
   */
  private addCrosshair(): void {
    // 从当前光标位置获取坐标
    const { x, y } = this.cursorPosition;
    // 显示十字准线，传入画布、坐标和缩放比例
    this.crosshair.show(this.canvas, x, y, this.geometry.scale);
  }

  /**
   * 移除画布上的十字准线
   * 隐藏当前显示的十字准线
   */
  private removeCrosshair(): void {
    // 隐藏十字准线
    this.crosshair.hide();
  }

  /**
   * 处理绘制完成事件
   * @param args - 传递给回调函数的参数
   *
   * 如果用户提供了自定义的onDrawDone回调，则调用它；
   * 否则调用默认的onDrawDoneDefault方法
   */
  private onDrawDone(
    data: object | null,
    duration?: number,
    continueDraw?: boolean,
    prevDrawData?: DrawData
  ): void {
    // 检查是否有自定义的绘制完成回调
    if (this.drawData!.onDrawDone) {
      // 调用自定义回调，传入所有参数
      this.drawData!.onDrawDone.call(this, data);
      return;
    }

    // 调用默认的绘制完成处理方法
    this.onDrawDoneDefault.call(this, data, duration, continueDraw, prevDrawData);
  }

  /**
   * 释放绘制资源并清理状态
   *
   * 执行以下操作：
   * 1. 停止自动边界处理
   * 2. 移除事件监听器
   * 3. 处理未保存的绘制形状
   * 4. 清理DOM元素和引用
   */
  private release(): void {
    // 防止递归调用
    if (!this.initialized) {
      return;
    }

    this.autoborderHandler.autoborder(false);
    this.initialized = false;
    this.canvas.off("mousedown.draw");
    this.canvas.off("mousemove.draw");

    // draw 插件（SVG.js 的 draw 扩展）在某些情况下并没有被激活。
    // 例如：
    // 1. 当通过 initialState 粘贴形状时（不是新建绘制），draw 插件可能未激活。
    // 2. 或者还没有绘制任何点，但调用了 cancel() 取消绘制，此时 draw 插件也可能未激活。
    // 所以在释放资源时，需要通过 remember 方法检查 draw 插件是否已激活，
    // 只有激活时才调用 draw('done') 和 draw('stop')，否则直接调用回调并做清理。
    if (this.drawInstance.remember("_paintHandler")) {
      if (["polygon", "polyline", "points"].includes(this.drawData!.shapeType!)) {
        // Check for unsaved drawn shapes
        this.drawInstance.draw("done");
      }
      // Clear drawing
      this.drawInstance.draw("stop");
    } else {
      this.onDrawDone(null);
      if (
        this.drawInstance &&
        this.drawData!.shapeType === "ellipse" &&
        !this.drawData!.initialState
      ) {
        this.drawInstance.fire("drawstop");
      }
    }

    // 清理点组
    if (this.pointsGroup) {
      this.pointsGroup.remove();
      this.pointsGroup = null;
    }

    // 清理绘制实例
    this.drawInstance.off();
    this.drawInstance.remove();
    this.drawInstance = null;

    // 清理形状大小元素
    if (this.shapeSizeElement) {
      this.shapeSizeElement.rm();
      this.shapeSizeElement = null;
    }

    // 移除十字准线
    if (this.crosshair) {
      this.removeCrosshair();
    }
  }

  /**
   * 初始化绘制环境
   * 根据绘制数据配置设置初始绘制环境，如显示十字准线
   */
  private initDrawing(): void {
    // 如果绘制数据中需要显示十字准线，则添加它
    if (this.drawData!.crosshair) {
      this.addCrosshair();
    }
  }

  /**
   * 绘制矩形框
   * 创建矩形绘制实例并设置相关事件处理
   */
  private drawBox(): void {
    // 创建矩形绘制实例
    this.drawInstance = this.canvas.rect();
    // 设置绘制停止事件处理
    this.drawInstance
      .on("drawstop", (e: Event): void => {
        // 从形状中读取点坐标
        const points = readPointsFromShape(
          (e.target as any as { instance: SVG.Rect }).instance
        );
        // 获取最终的矩形坐标，确保适应框架
        const [xtl, ytl, xbr, ybr] = this.getFinalRectCoordinates(points, true);
        // 获取形状类型和客户端ID
        const { shapeType, redraw: clientID } = this.drawData!;

        // 如果绘制已取消，则返回
        if (this.canceled) {
          return;
        }

        // 释放绘制资源
        this.release();
        // 检查矩形约束条件
        if (checkConstraint("rectangle", [xtl, ytl, xbr, ybr])) {
          // 调用绘制完成回调，传递形状数据
          this.onDrawDone(
            {
              clientID,
              shapeType,
              points: [xtl, ytl, xbr, ybr],
            },
            Date.now() - this.startTimestamp
          );
        } else {
          // 约束条件不满足，传递null
          this.onDrawDone(null);
        }
      })
      // 设置绘制更新事件处理
      .on("drawupdate", (): void => {
        // 更新形状大小显示
        this.shapeSizeElement!.update(this.drawInstance);
      })
      // 添加CSS类
      .addClass("cvat_canvas_shape_drawing")
      // 设置样式属性
      .attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "fill-opacity": this.selectedShapeOpacity,
        stroke: this.outlinedBorders,
      });
  }

  /**
   * 绘制椭圆
   * 创建椭圆绘制实例并设置相关事件处理
   */
  private drawEllipse(): void {
    // 创建椭圆绘制实例并设置基本样式
    this.drawInstance = (this.canvas as any)
      .ellipse()
      .addClass("cvat_canvas_shape_drawing")
      .attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "fill-opacity": this.selectedShapeOpacity,
        stroke: this.outlinedBorders,
      });

    // 初始化初始点对象
    const initialPoint: {
      x: number | null;
      y: number | null;
    } = {
      x: null,
      y: null,
    };

    // 设置鼠标按下事件处理
    this.canvas.on("mousedown.draw", (e: MouseEvent): void => {
      // 只处理左键点击且未按住Alt键
      if (e.button === 0 && !e.altKey) {
        // 如果是第一次点击，记录初始点
        if (initialPoint.x === null || initialPoint.y === null) {
          // 将屏幕坐标转换为SVG坐标
          const translated = translateToSVG(this.canvas.node as any as SVGSVGElement, [
            e.clientX,
            e.clientY,
          ]);
          [initialPoint.x, initialPoint.y] = translated;
        } else {
          // 第二次点击触发绘制停止事件
          this.drawInstance.fire("drawstop");
        }
      }
    });

    // 设置鼠标移动事件处理
    this.canvas.on("mousemove.draw", (e: MouseEvent): void => {
      // 只有在设置了初始点后才处理鼠标移动
      if (initialPoint.x !== null && initialPoint.y !== null) {
        // 将屏幕坐标转换为SVG坐标
        const translated = translateToSVG(this.canvas.node as any as SVGSVGElement, [
          e.clientX,
          e.clientY,
        ]);
        // 计算椭圆的x和y半径
        const rx = Math.abs(translated[0] - initialPoint.x) / 2;
        const ry = Math.abs(translated[1] - initialPoint.y) / 2;
        // 计算椭圆中心点
        const cx = initialPoint.x + rx * Math.sign(translated[0] - initialPoint.x);
        const cy = initialPoint.y + ry * Math.sign(translated[1] - initialPoint.y);
        // 设置椭圆中心和半径
        this.drawInstance.center(cx, cy);
        this.drawInstance.radius(rx, ry);
        // 更新形状大小显示
        this.shapeSizeElement!.update(this.drawInstance);
      }
    });

    // 设置绘制停止事件处理
    this.drawInstance.on("drawstop", () => {
      // 移除绘制停止事件监听器，防止重复触发
      this.drawInstance.off("drawstop");
      // 从形状中读取点坐标并获取最终椭圆坐标
      const points = this.getFinalEllipseCoordinates(
        readPointsFromShape(this.drawInstance),
        false
      );
      // 获取形状类型和客户端ID
      const { shapeType, redraw: clientID } = this.drawData!;

      // 如果绘制已取消，则返回
      if (this.canceled) {
        return;
      }

      // 释放绘制资源
      this.release();
      // 检查椭圆约束条件
      if (checkConstraint("ellipse", points)) {
        // 调用绘制完成回调，传递形状数据
        this.onDrawDone(
          {
            clientID,
            shapeType,
            points,
          },
          Date.now() - this.startTimestamp
        );
      } else {
        // 约束条件不满足，传递null
        this.onDrawDone(null);
      }
    });
  }

  /**
   * 通过四个点绘制矩形框
   * 允许用户通过点击四个点来定义一个矩形框
   */
  private drawBoxBy4Points(): void {
    // 初始化点计数器
    let numberOfPoints = 0;
    // 创建多边形绘制实例，设置透明样式
    this.drawInstance = (this.canvas as any)
      .polygon()
      .addClass("cvat_canvas_shape_drawing")
      .attr({
        "stroke-width": 0,
        opacity: 0,
      })
      // 设置绘制开始事件处理
      .on("drawstart", (): void => {
        // 在绘制开始时初始化点计数器为1
        numberOfPoints = 1;
      })
      // 设置绘制点事件处理
      .on("drawpoint", (e: CustomEvent): void => {
        // 每添加一个点，计数器加1
        numberOfPoints += 1;

        // 当点数达到4个时完成绘制
        if (numberOfPoints === 4) {
          // 获取多边形的边界框
          const bbox = (e.target as SVGPolylineElement).getBBox();
          // 计算边界框的坐标
          const points = [bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height];
          // 获取最终的矩形坐标，确保适应框架
          const [xtl, ytl, xbr, ybr] = this.getFinalRectCoordinates(points, true);
          // 获取形状类型和客户端ID
          const { shapeType, redraw: clientID } = this.drawData!;
          // 取消当前绘制
          this.cancel();

          // 检查矩形约束条件
          if (checkConstraint("rectangle", [xtl, ytl, xbr, ybr])) {
            // 调用绘制完成回调，传递形状数据
            this.onDrawDone(
              {
                shapeType,
                clientID,
                points: [xtl, ytl, xbr, ybr],
              },
              Date.now() - this.startTimestamp
            );
          }
        }
      })
      // 设置撤销点事件处理
      .on("undopoint", (): void => {
        // 确保点计数器不小于0
        if (numberOfPoints > 0) {
          numberOfPoints -= 1;
        }
      });

    // 调用多边形绘制方法
    this.drawPolyshape();
  }

  /**
   * 绘制多边形形状（多边形、折线、点集或立方体）
   *
   * 设置多边形绘制的事件处理，包括：
   * 1. 点计数管理
   * 2. 右键撤销功能
   * 3. 按住Shift键滑动绘制
   * 4. 绘制完成处理
   */
  private drawPolyshape(): void {
    // 根据形状类型确定需要的点数，立方体固定为4个点
    let size = this.drawData!.shapeType === "cuboid" ? 4 : this.drawData!.numberOfPoints;

    // 创建点计数递减函数
    const sizeDecrement = (): void => {
      // 当点数减到0时，完成绘制
      if (--size! === 0) {
        // 需要额外的setTimeout，因为不能在drawstart事件监听器中直接调用draw('done')
        // 这是由于svg.js的实现限制
        setTimeout((): void => this.drawInstance.draw("done"));
      }
    };

    // 为绘制开始和绘制点事件绑定点计数递减函数
    this.drawInstance.on("drawstart", sizeDecrement);
    this.drawInstance.on("drawpoint", sizeDecrement);
    // 为绘制更新事件绑定变换函数
    this.drawInstance.on("drawupdate", (): void => this.transform(this.geometry));
    // 为撤销点事件绑定点计数递增函数
    this.drawInstance.on("undopoint", (): number => size!++);

    // 添加撤销最新绘制点的功能
    this.canvas.on("mousedown.draw", (e: MouseEvent): void => {
      // 右键点击时撤销最后一个点
      if (e.button === 2) {
        e.stopPropagation();
        e.preventDefault();
        this.drawInstance.draw("undo");
      }
    });

    // 添加通过滑动绘制形状的功能
    // 需要记住最后绘制的点以实现滑动绘制
    const lastDrawnPoint: {
      x: number | null;
      y: number | null;
    } = {
      x: null,
      y: null,
    };

    // 处理鼠标移动事件以支持滑动绘制
    this.canvas.on("mousemove.draw", (e: MouseEvent): void => {
      // TODO: 在cvat-core类型化后使用枚举
      // 只有在按住Shift键且形状为多边形或折线时才启用滑动绘制
      if (e.shiftKey && ["polygon", "polyline"].includes(this.drawData!.shapeType!)) {
        // 如果是第一个点，直接添加
        if (lastDrawnPoint.x === null || lastDrawnPoint.y === null) {
          this.drawInstance.draw("point", e);
        } else {
          // 否则更新当前点位置
          this.drawInstance.draw("update", e);
          // 计算与上一个点的距离
          const deltaThreshold = 15;
          const dx = (e.clientX - lastDrawnPoint.x) ** 2;
          const dy = (e.clientY - lastDrawnPoint.y) ** 2;
          const delta = Math.sqrt(dx + dy);
          // 如果距离超过阈值，添加新点
          if (delta > deltaThreshold) {
            this.drawInstance.draw("point", e);
          }
        }

        // 阻止事件冒泡和默认行为
        e.stopPropagation();
        e.preventDefault();
      }
    });

    // 缩放刚刚绘制的点
    this.drawInstance.on("drawstart drawpoint", (e: CustomEvent): void => {
      // 应用几何变换
      this.transform(this.geometry);
      // 记录最后绘制的点坐标
      lastDrawnPoint.x = e.detail.event.clientX;
      lastDrawnPoint.y = e.detail.event.clientY;
    });

    // 处理绘制完成事件
    this.drawInstance.on("drawdone", (e: CustomEvent): void => {
      // 从形状中读取点坐标
      const targetPoints = readPointsFromShape(
        (e.target as any as { instance: SVG.Shape }).instance
      );
      // 获取形状类型和客户端ID
      const { shapeType, redraw: clientID } = this.drawData!;
      // 根据形状类型获取最终坐标
      const { points, box } =
        shapeType === "cuboid"
          ? this.getFinalCuboidCoordinates(targetPoints)
          : this.getFinalPolyshapeCoordinates(targetPoints, true);

      // 如果绘制已取消，则返回
      if (this.canceled) {
        return;
      }

      // 释放绘制资源
      this.release();
      // 检查形状约束条件
      if (checkConstraint(shapeType!, points, box)) {
        // 调用绘制完成回调，传递形状数据
        this.onDrawDone(
          { clientID, shapeType, points },
          Date.now() - this.startTimestamp
        );
      } else {
        // 约束条件不满足，传递null
        this.onDrawDone(null);
      }
    });
  }

  /**
   * 绘制多边形
   *
   * 创建多边形绘制实例，设置样式属性，并启用多边形绘制功能
   * 如果启用了自动边界功能，则应用自动边界处理
   */
  private drawPolygon(): void {
    // 创建多边形绘制实例并设置样式
    this.drawInstance = (this.canvas as any)
      .polygon()
      .addClass("cvat_canvas_shape_drawing")
      .attr({
        // 根据几何缩放比例设置描边宽度
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        // 设置填充透明度
        "fill-opacity": this.selectedShapeOpacity,
        // 设置描边颜色
        stroke: this.outlinedBorders,
      });

    // 调用多边形绘制方法
    this.drawPolyshape();
    // 如果启用了自动边界功能，则应用自动边界处理
    if (this.autobordersEnabled) {
      this.autoborderHandler.autoborder(true, this.drawInstance, this.drawData!.redraw);
    }
  }

  /**
   * 绘制折线
   *
   * 创建折线绘制实例，设置样式属性（无填充），并启用多边形绘制功能
   * 如果启用了自动边界功能，则应用自动边界处理
   */
  private drawPolyline(): void {
    // 创建折线绘制实例并设置样式
    this.drawInstance = (this.canvas as any)
      .polyline()
      .addClass("cvat_canvas_shape_drawing")
      .attr({
        // 根据几何缩放比例设置描边宽度
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        // 折线不填充，透明度为0
        "fill-opacity": 0,
        // 设置描边颜色
        stroke: this.outlinedBorders,
      });

    // 调用多边形绘制方法
    this.drawPolyshape();
    // 如果启用了自动边界功能，则应用自动边界处理
    if (this.autobordersEnabled) {
      this.autoborderHandler.autoborder(true, this.drawInstance, this.drawData!.redraw);
    }
  }

  /**
   * 绘制点集
   *
   * 创建透明多边形绘制实例作为点集的容器，不显示描边和填充
   * 启用多边形绘制功能以处理点的交互
   */
  private drawPoints(): void {
    // 创建透明多边形绘制实例作为点集容器
    this.drawInstance = (this.canvas as any)
      .polygon()
      .addClass("cvat_canvas_shape_drawing")
      .attr({
        // 不显示描边
        "stroke-width": 0,
        // 完全透明
        opacity: 0,
      });

    // 调用多边形绘制方法处理点的交互
    this.drawPolyshape();
  }

  /**
   * 通过四个点绘制立方体
   *
   * 创建折线绘制实例作为立方体绘制的容器，设置基本样式
   * 启用多边形绘制功能以处理四个点的交互
   */
  private drawCuboidBy4Points(): void {
    // 创建折线绘制实例作为立方体绘制的容器
    this.drawInstance = (this.canvas as any)
      .polyline()
      .addClass("cvat_canvas_shape_drawing")
      .attr({
        // 根据几何缩放比例设置描边宽度
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        // 设置描边颜色
        stroke: this.outlinedBorders,
      });
    // 调用多边形绘制方法处理四个点的交互
    this.drawPolyshape();
  }

  /**
   * 绘制骨架
   * 创建矩形绘制实例和骨架点组，设置事件处理，实现骨架的交互式绘制
   */
  private drawSkeleton(): void {
    // 创建矩形绘制实例并设置描边颜色
    this.drawInstance = this.canvas.rect().attr({
      stroke: this.outlinedBorders,
    });
    // 从骨架SVG模板创建点组
    this.pointsGroup = makeSVGFromTemplate(this.drawData!.skeletonSVG!);
    // 将点组添加到画布
    this.canvas.add(this.pointsGroup);
    // 设置点组描边宽度
    this.pointsGroup.attr("stroke-width", consts.BASE_STROKE_WIDTH / this.geometry.scale);
    // 设置点组描边颜色
    this.pointsGroup.attr("stroke", this.outlinedBorders);

    // 初始化边界值
    let minX = Number.MAX_SAFE_INTEGER;
    let minY = Number.MAX_SAFE_INTEGER;
    let maxX = 0;
    let maxY = 0;

    // 遍历点组中的所有子元素，计算边界
    this.pointsGroup.children().forEach((child: SVG.Element): void => {
      const cx = child.cx();
      const cy = child.cy();
      minX = Math.min(cx, minX);
      minY = Math.min(cy, minY);
      maxX = Math.max(cx, maxX);
      maxY = Math.max(cy, maxY);
    });

    this.drawInstance
      // 设置绘制停止事件处理
      .on("drawstop", (e: Event): void => {
        // 从形状中读取点坐标
        const points = readPointsFromShape(
          (e.target as any as { instance: SVG.Rect }).instance
        );
        // 获取最终矩形坐标
        const [xtl, ytl, xbr, ybr] = this.getFinalRectCoordinates(points, true);
        // 初始化元素数组
        const elements: any[] = [];
        // 遍历点组中的所有子元素
        Array.from(this.pointsGroup!.node.children).forEach((child: Element) => {
          // 处理圆形元素（骨架点）
          if (child.tagName === "circle") {
            // 计算相对于矩形左上角的坐标
            const cx = +(child.getAttribute("cx") as string) + xtl;
            const cy = +(child.getAttribute("cy") as string) + ytl;
            // 获取标签ID
            const label = +child.getAttribute("data-label-id")!;
            // 添加到元素数组
            elements.push({
              shapeType: "points",
              points: [cx, cy],
              labelID: label,
            });
          }
        });

        const { shapeType, redraw: clientID } = this.drawData!;

        // 如果绘制被取消，直接返回
        if (this.canceled) {
          return;
        }

        // 释放绘制资源
        this.release();
        // 检查骨架约束条件
        if (checkConstraint("skeleton", [xtl, ytl, xbr, ybr])) {
          // 调用绘制完成回调，传递骨架元素
          this.onDrawDone(
            {
              clientID,
              shapeType,
              elements,
            },
            Date.now() - this.startTimestamp
          );
        } else {
          // 约束条件不满足时，传递null
          this.onDrawDone(null);
        }
      })
      // 设置绘制更新事件处理
      .on("drawupdate", (): void => {
        // 获取矩形的位置和尺寸
        const x = this.drawInstance.x();
        const y = this.drawInstance.y();
        const width = this.drawInstance.width();
        const height = this.drawInstance.height();
        // 设置点组的变换，使其跟随矩形移动
        this.pointsGroup!.style({
          transform: `translate(${x}px, ${y}px)`,
        });

        // 更新点组的内部HTML为骨架SVG模板
        this.pointsGroup!.node.innerHTML = this.drawData!.skeletonSVG!;
        // 处理骨架点元素
        Array.from(this.pointsGroup!.node.children).forEach((child: Element) => {
          const dataType = child.getAttribute("data-type");
          // 处理圆形元素（骨架点）
          if (child.tagName === "circle" && dataType && dataType.includes("element")) {
            // 设置点半径
            child.setAttribute("r", `${this.controlPointsSize / this.geometry.scale}`);
            let cx = +(child.getAttribute("cx") as string);
            let cy = +(child.getAttribute("cy") as string);
            // 计算相对于原始边界的偏移比例
            const cxOffset = (cx - minX) / (maxX - minX);
            const cyOffset = (cy - minY) / (maxY - minY);
            // 计算相对于当前矩形的位置
            cx = Number.isNaN(cxOffset) ? 0.5 * width : cxOffset * width;
            cy = Number.isNaN(cyOffset) ? 0.5 * height : cyOffset * height;
            // 更新点的位置
            child.setAttribute("cx", `${cx}`);
            child.setAttribute("cy", `${cy}`);
          }
        });

        // 处理骨架边元素
        Array.from(this.pointsGroup!.node.children).forEach((child: Element) => {
          const dataType = child.getAttribute("data-type");
          // 处理线条元素（骨架边）
          if (child.tagName === "line" && dataType && dataType.includes("edge")) {
            // 继承父元素的描边样式
            child.setAttribute("stroke-width", "inherit");
            child.setAttribute("stroke", "inherit");
            // 获取连接的节点ID
            const dataNodeFrom = child.getAttribute("data-node-from");
            const dataNodeTo = child.getAttribute("data-node-to");
            if (dataNodeFrom && dataNodeTo) {
              // 查找连接的节点
              const from = this.pointsGroup!.node.querySelector(
                `[data-node-id="${dataNodeFrom}"]`
              );
              const to = this.pointsGroup!.node.querySelector(
                `[data-node-id="${dataNodeTo}"]`
              );

              if (from && to) {
                // 获取节点的坐标
                const x1 = from.getAttribute("cx");
                const y1 = from.getAttribute("cy");
                const x2 = to.getAttribute("cx");
                const y2 = to.getAttribute("cy");

                if (x1 && y1 && x2 && y2) {
                  // 更新线条的端点坐标
                  child.setAttribute("x1", x1);
                  child.setAttribute("y1", y1);
                  child.setAttribute("x2", x2);
                  child.setAttribute("y2", y2);
                }
              }
            }
            // 以下代码似乎有误，可能是遗留代码，cx和cy不应该在这里设置
            let cx = +(child.getAttribute("cx") as string);
            let cy = +(child.getAttribute("cy") as string);
            const cxOffset = cx / 100;
            const cyOffset = cy / 100;
            cx = cxOffset * width;
            cy = cyOffset * height;
            child.setAttribute("cx", `${cx}`);
            child.setAttribute("cy", `${cy}`);
          }
        });
      })
      // 添加绘制样式类
      .addClass("cvat_canvas_shape_drawing")
      // 设置样式属性
      .attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "fill-opacity": this.selectedShapeOpacity,
      });
  }

  /**
   * 粘贴多边形形状
   * 处理多边形、立方体等形状的粘贴操作，设置完成事件处理
   */
  private pastePolyshape(): void {
    // 设置完成事件处理
    this.drawInstance.on("done", (e: CustomEvent): void => {
      // 从形状属性中提取点坐标
      const targetPoints = this.drawInstance
        .attr("points")
        .split(/[,\s]/g)
        .map((coord: string): number => +coord);

      // 获取形状类型
      const { shapeType } = this.drawData!.initialState;
      // 根据形状类型获取最终坐标
      const { points, box } =
        shapeType === "cuboid"
          ? this.getFinalCuboidCoordinates(targetPoints)
          : this.getFinalPolyshapeCoordinates(targetPoints, true);

      // 检查形状约束条件
      if (checkConstraint(shapeType, points, box)) {
        // 调用绘制完成回调
        this.onDrawDone(
          {
            shapeType,
            objectType: this.drawData!.initialState.objectType,
            points,
            occluded: this.drawData!.initialState.occluded,
            attributes: { ...this.drawData!.initialState.attributes },
            label: this.drawData!.initialState.label,
            color: this.drawData!.initialState.color,
          },
          Date.now() - this.startTimestamp,
          e.detail.originalEvent.ctrlKey,
          this.drawData!
        );
      }

      // 如果未按住Ctrl键，释放绘制资源
      if (!e.detail.originalEvent.ctrlKey) {
        this.release();
      }
    });
  }

  /**
   * 粘贴形状的通用设置
   * 为矩形和多边形形状提供通用的移动和鼠标事件处理
   */
  private pasteShape(): void {
    // 定义移动形状的函数，保持旋转角度不变
    const moveShape = (shape: SVG.Shape, x: number, y: number): void => {
      // 获取当前旋转角度
      const { rotation } = shape.transform();
      // 重置变换
      shape.untransform();
      // 设置新中心点
      shape.center(x, y);
      // 恢复旋转角度
      shape.rotate(rotation!);
    };

    // 获取初始光标位置
    const { x: initialX, y: initialY } = this.cursorPosition;
    // 将形状移动到初始位置
    moveShape(this.drawInstance, initialX, initialY);

    // 设置鼠标移动事件处理
    this.canvas.on("mousemove.draw", (): void => {
      // 获取当前光标位置（在其他回调中计算）
      const { x, y } = this.cursorPosition;
      // 移动形状到新位置
      moveShape(this.drawInstance, x, y);
    });
  }

  /**
   * 粘贴矩形框
   * 创建矩形实例并设置样式、旋转和事件处理
   * @param box 矩形边界框，包含宽度、高度和位置信息
   * @param rotation 旋转角度
   */
  private pasteBox(box: BBox, rotation: number): void {
    // 创建矩形实例并设置尺寸、位置、样式和旋转
    this.drawInstance = (this.canvas as any)
      .rect(box.width, box.height)
      .center(box.x, box.y)
      .addClass("cvat_canvas_shape_drawing")
      .attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "fill-opacity": this.selectedShapeOpacity,
        stroke: this.outlinedBorders,
      })
      .rotate(rotation);
    // 应用通用形状粘贴设置
    this.pasteShape();

    // 设置完成事件处理
    this.drawInstance.on("done", (e: CustomEvent): void => {
      // 从形状中读取点坐标
      const points = readPointsFromShape(
        (e.target as any as { instance: SVG.Rect }).instance
      );
      // 获取最终矩形坐标
      const [xtl, ytl, xbr, ybr] = this.getFinalRectCoordinates(
        points,
        !this.drawData!.initialState.rotation
      );
      // 检查矩形约束条件
      if (checkConstraint("rectangle", [xtl, ytl, xbr, ybr])) {
        // 调用绘制完成回调
        this.onDrawDone(
          {
            shapeType: this.drawData!.initialState.shapeType,
            objectType: this.drawData!.initialState.objectType,
            points: [xtl, ytl, xbr, ybr],
            occluded: this.drawData!.initialState.occluded,
            attributes: { ...this.drawData!.initialState.attributes },
            label: this.drawData!.initialState.label,
            color: this.drawData!.initialState.color,
            rotation: this.drawData!.initialState.rotation,
          },
          Date.now() - this.startTimestamp,
          e.detail.originalEvent.ctrlKey,
          this.drawData!
        );
      }

      // 如果未按住Ctrl键，释放绘制资源
      if (!e.detail.originalEvent.ctrlKey) {
        this.release();
      }
    });
  }

  /**
   * 粘贴椭圆
   * 创建椭圆实例并设置样式、旋转和事件处理
   * @param params 椭圆参数数组，包含中心点坐标(cx, cy)和半径(rx, ry)
   * @param rotation 旋转角度
   */
  private pasteEllipse([cx, cy, rx, ry]: number[], rotation: number): void {
    // 创建椭圆实例并设置尺寸、位置、样式和旋转
    this.drawInstance = (this.canvas as any)
      .ellipse(rx * 2, ry * 2)
      .center(cx, cy)
      .addClass("cvat_canvas_shape_drawing")
      .attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "fill-opacity": this.selectedShapeOpacity,
        stroke: this.outlinedBorders,
      })
      .rotate(rotation);
    // 应用通用形状粘贴设置
    this.pasteShape();

    // 设置完成事件处理
    this.drawInstance.on("done", (e: CustomEvent): void => {
      // 获取最终椭圆坐标
      const points = this.getFinalEllipseCoordinates(
        readPointsFromShape((e.target as any as { instance: SVG.Ellipse }).instance),
        false
      );
      // 检查椭圆约束条件
      if (checkConstraint("ellipse", points)) {
        // 调用绘制完成回调
        this.onDrawDone(
          {
            shapeType: this.drawData!.initialState.shapeType,
            objectType: this.drawData!.initialState.objectType,
            points,
            occluded: this.drawData!.initialState.occluded,
            attributes: { ...this.drawData!.initialState.attributes },
            label: this.drawData!.initialState.label,
            color: this.drawData!.initialState.color,
            rotation: this.drawData!.initialState.rotation,
          },
          Date.now() - this.startTimestamp,
          e.detail.originalEvent.ctrlKey,
          this.drawData!
        );
      }

      // 如果未按住Ctrl键，释放绘制资源
      if (!e.detail.originalEvent.ctrlKey) {
        this.release();
      }
    });
  }

  /**
   * 粘贴多边形
   * @param points 多边形点坐标字符串
   * 创建多边形实例，设置样式属性，并应用通用形状粘贴和多边形粘贴设置
   */
  private pastePolygon(points: string): void {
    // 创建多边形实例并设置样式
    this.drawInstance = (this.canvas as any)
      .polygon(points)
      .addClass("cvat_canvas_shape_drawing")
      .attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "fill-opacity": this.selectedShapeOpacity,
        stroke: this.outlinedBorders,
      });
    // 应用通用形状粘贴设置
    this.pasteShape();
    // 应用多边形特定粘贴设置
    this.pastePolyshape();
  }

  /**
   * 粘贴折线
   * @param points 折线点坐标字符串
   * 创建折线实例，设置样式属性，并应用通用形状粘贴和多边形粘贴设置
   */
  private pastePolyline(points: string): void {
    // 创建折线实例并设置样式
    this.drawInstance = (this.canvas as any)
      .polyline(points)
      .addClass("cvat_canvas_shape_drawing")
      .attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        stroke: this.outlinedBorders,
      });
    // 应用通用形状粘贴设置
    this.pasteShape();
    // 应用多边形特定粘贴设置
    this.pastePolyshape();
  }

  /**
   * 粘贴立方体
   * @param points 立方体点坐标字符串
   * 创建立方体实例，设置样式属性，并应用通用形状粘贴和多边形粘贴设置
   */
  private pasteCuboid(points: string): void {
    // 创建立方体实例并设置样式
    this.drawInstance = (this.canvas as any)
      .cube(points)
      .addClass("cvat_canvas_shape_drawing")
      .attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "face-stroke": this.outlinedBorders,
        "fill-opacity": this.selectedShapeOpacity,
        stroke: this.outlinedBorders,
      });
    // 应用通用形状粘贴设置
    this.pasteShape();
    // 应用多边形特定粘贴设置
    this.pastePolyshape();
  }

  /**
   * 粘贴骨架
   * @param box 骨架边界框
   * @param elements 骨架元素数组
   * 创建骨架实例，设置样式属性，处理骨架点位置，并添加事件处理
   */
  private pasteSkeleton(box: BBox, elements: any[]): void {
    // 获取几何偏移量
    const { offset } = this.geometry;
    // 初始化左上角坐标
    let [xtl, ytl] = [box.x, box.y];

    // 创建矩形框作为骨架容器
    this.pasteBox(box, 0);
    // 从SVG模板创建骨架点组
    this.pointsGroup = makeSVGFromTemplate(this.drawData!.skeletonSVG!);
    // 设置骨架点组样式
    this.pointsGroup.attr({
      "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
      stroke: this.outlinedBorders,
    });
    // 将骨架点组添加到画布
    this.canvas.add(this.pointsGroup);

    // 遍历骨架点组的子元素
    this.pointsGroup.children().forEach((child: SVG.Element): void => {
      // 获取元素数据类型
      const dataType = child.attr("data-type");
      // 处理骨架点元素
      if (child.node.tagName === "circle" && dataType && dataType.includes("element")) {
        // 设置点的大小
        child.attr("r", `${this.controlPointsSize / this.geometry.scale}`);
        // 获取标签ID
        const labelID = +child.attr("data-label-id");
        // 查找对应的元素
        const element = elements.find(
          (_element: any): boolean => _element.label.id === labelID
        );
        if (element) {
          // 转换坐标到画布坐标系
          const points = translateToCanvas(offset, element.points);
          // 设置点的中心位置
          child.center(points[0], points[1]);
        }
      }
    });

    // 设置绘制完成事件处理
    this.drawInstance.off("done").on("done", (e: CustomEvent) => {
      // 构建结果对象
      const result = {
        shapeType: this.drawData!.initialState.shapeType,
        objectType: this.drawData!.initialState.objectType,
        // 映射元素数据，更新点坐标
        elements: this.drawData!.initialState.elements.map((element: any) => ({
          shapeType: element.shapeType,
          outside: element.outside,
          occluded: element.occluded,
          label: element.label,
          attributes: element.attributes,
          // 获取更新后的点坐标
          points: (() => {
            // 查找对应的圆点元素
            const circle = this.pointsGroup!.children().find(
              (child: SVG.Element) => child.attr("data-label-id") === element.label.id
            );
            // 转换坐标从画布坐标系
            const points = translateFromCanvas(this.geometry.offset, [
              circle!.cx(),
              circle!.cy(),
            ]);
            return points;
          })(),
        })),
        occluded: this.drawData!.initialState.occluded,
        attributes: { ...this.drawData!.initialState.attributes },
        label: this.drawData!.initialState.label,
        color: this.drawData!.initialState.color,
        rotation: this.drawData!.initialState.rotation,
      };

      // 调用绘制完成回调
      this.onDrawDone(
        result,
        Date.now() - this.startTimestamp,
        e.detail.originalEvent.ctrlKey,
        this.drawData!
      );

      // 如果未按住Ctrl键，释放绘制资源
      if (!e.detail.originalEvent.ctrlKey) {
        this.release();
      }
    });

    // 设置鼠标移动事件处理
    this.canvas.on("mousemove.draw", (): void => {
      // 获取当前矩形位置和尺寸
      const [newXtl, newYtl] = [
        this.drawInstance.x(),
        this.drawInstance.y(),
        this.drawInstance.width(),
        this.drawInstance.height(),
      ];
      // 计算位置差值
      const [xDiff, yDiff] = [newXtl - xtl, newYtl - ytl];
      // 更新左上角坐标
      xtl = newXtl;
      ytl = newYtl;
      // 更新所有骨架点的位置
      this.pointsGroup!.children().forEach((child: SVG.Element): void => {
        // 获取元素数据类型
        const dataType = child.attr("data-type");
        // 处理骨架点元素
        if (child.node.tagName === "circle" && dataType && dataType.includes("element")) {
          // 获取当前点坐标
          const [cx, cy] = [child.cx(), child.cy()];
          // 更新点位置
          child.center(cx + xDiff, cy + yDiff);
        }
      });
      // 重置点组变换
      this.pointsGroup!.untransform();
      // 设置骨架边连接
      setupSkeletonEdges(this.pointsGroup!, this.pointsGroup!);
    });
  }

  /**
   * 粘贴点集
   * @param initialPoints 初始点坐标字符串
   * 创建点集实例，设置样式属性，并添加移动和事件处理
   */
  private pastePoints(initialPoints: string): void {
    // 定义移动形状的函数
    const moveShape = (
      shape: SVG.PolyLine,
      group: SVG.G,
      x: number,
      y: number,
      scale: number
    ): void => {
      // 获取形状边界框
      const bbox = shape.bbox();
      // 移动形状到指定位置
      shape.move(x - bbox.width / 2, y - bbox.height / 2);

      // 解析点坐标
      const points = shape.attr("points").split(" ");
      // 计算点半径
      const radius = this.controlPointsSize / scale;

      // 更新每个点的位置
      group.children().forEach((child: SVG.Element, idx: number): void => {
        const [px, py] = points[idx].split(",");
        child.move(px - radius / 2, py - radius / 2);
      });
    };

    // 获取初始光标位置
    const { x: initialX, y: initialY } = this.cursorPosition;
    // 创建点组
    this.pointsGroup = this.canvas.group();
    // 创建折线实例作为点集容器
    this.drawInstance = (this.canvas as any)
      .polyline(initialPoints)
      .addClass("cvat_canvas_shape_drawing")
      .style({
        "stroke-width": 0,
      });

    // 计算点数量
    let numOfPoints = initialPoints.split(" ").length;
    // 创建点元素
    while (numOfPoints) {
      numOfPoints--;
      // 计算点半径和描边宽度
      const radius = this.controlPointsSize / this.geometry.scale;
      const stroke = consts.POINTS_STROKE_WIDTH / this.geometry.scale;
      // 创建圆点
      this.pointsGroup.circle().fill("white").stroke("black").attr({
        r: radius,
        "stroke-width": stroke,
      });
    }

    // 初始化点集位置
    moveShape(
      this.drawInstance,
      this.pointsGroup,
      initialX,
      initialY,
      this.geometry.scale
    );

    // 设置鼠标移动事件处理
    this.canvas.on("mousemove.draw", (): void => {
      // 获取当前光标位置
      const { x, y } = this.cursorPosition;
      // 更新点集位置
      moveShape(this.drawInstance, this.pointsGroup!, x, y, this.geometry.scale);
    });

    // 应用多边形粘贴设置
    this.pastePolyshape();
  }

  /**
   * 设置粘贴事件处理
   * 为鼠标按下事件添加处理，当左键按下且未按住Alt键时触发完成事件
   */
  private setupPasteEvents(): void {
    // 设置鼠标按下事件处理
    this.canvas.on("mousedown.draw", (e: MouseEvent): void => {
      // 检查是否为左键按下且未按住Alt键
      if (e.button === 0 && !e.altKey) {
        // 触发完成事件
        this.drawInstance.fire("done", { originalEvent: e });
      }
    });
  }

  /**
   * 设置绘制事件处理
   * 为鼠标按下事件添加处理，支持初始化绘制和继续绘制
   */
  private setupDrawEvents(): void {
    // 初始化标志
    let initialized = false;

    // 设置鼠标按下事件处理
    this.canvas.on("mousedown.draw", (e: MouseEvent): void => {
      // 检查是否为左键按下且未按住Alt键
      if (e.button === 0 && !e.altKey) {
        // 如果未初始化，初始化绘制
        if (!initialized) {
          // 初始化绘制，启用网格对齐
          this.drawInstance.draw(e, { snapToGrid: 0.1 });
          initialized = true;
        } else {
          // 继续绘制
          this.drawInstance.draw(e);
        }
      }
    });
  }

  /**
   * 开始绘制
   * 根据绘制数据类型和初始状态，初始化相应的绘制模式
   */
  private startDraw(): void {
    // TODO: Use enums after typification cvat-core
    // 如果有初始状态，执行粘贴操作
    if (this.drawData!.initialState) {
      // 获取几何偏移量
      const { offset } = this.geometry;
      // 根据形状类型执行相应的粘贴操作
      if (this.drawData!.shapeType === "rectangle") {
        // 转换矩形坐标到画布坐标系
        const [xtl, ytl, xbr, ybr] = translateToCanvas(
          offset,
          this.drawData!.initialState.points
        );
        // 粘贴矩形
        this.pasteBox(
          {
            x: xtl,
            y: ytl,
            width: xbr - xtl,
            height: ybr - ytl,
          },
          this.drawData!.initialState.rotation
        );
      } else if (this.drawData!.shapeType === "ellipse") {
        // 转换椭圆坐标到画布坐标系
        const [cx, cy, rightX, topY] = translateToCanvas(
          offset,
          this.drawData!.initialState.points
        );
        // 粘贴椭圆
        this.pasteEllipse(
          [cx, cy, rightX - cx, cy - topY],
          this.drawData!.initialState.rotation
        );
      } else if (this.drawData!.shapeType === "skeleton") {
        // 计算骨架边界框
        const box = computeWrappingBox(
          translateToCanvas(offset, this.drawData!.initialState.points),
          consts.SKELETON_RECT_MARGIN
        );
        // 粘贴骨架
        this.pasteSkeleton(box, this.drawData!.initialState.elements);
      } else {
        // 转换点坐标到画布坐标系
        const points = translateToCanvas(offset, this.drawData!.initialState.points);
        // 将点坐标转换为字符串
        const stringifiedPoints = stringifyPoints(points);

        // 根据形状类型执行相应的粘贴操作
        if (this.drawData!.shapeType === "polygon") {
          this.pastePolygon(stringifiedPoints);
        } else if (this.drawData!.shapeType === "polyline") {
          this.pastePolyline(stringifiedPoints);
        } else if (this.drawData!.shapeType === "points") {
          this.pastePoints(stringifiedPoints);
        } else if (this.drawData!.shapeType === "cuboid") {
          this.pasteCuboid(stringifiedPoints);
        }
      }
      // 设置粘贴事件
      this.setupPasteEvents();
    } else {
      // 如果没有初始状态，执行新绘制操作
      if (this.drawData!.shapeType === "rectangle") {
        // 根据矩形绘制方法执行相应的绘制操作
        if (this.drawData!.rectDrawingMethod === RectDrawingMethod.EXTREME_POINTS) {
          // 通过四个点绘制矩形
          this.drawBoxBy4Points();
        } else {
          // 默认矩形绘制方法
          this.drawBox();
          // 显示形状尺寸
          this.shapeSizeElement = displayShapeSize(this.canvas, this.text);
        }
      } else if (this.drawData!.shapeType === "polygon") {
        // 绘制多边形
        this.drawPolygon();
      } else if (this.drawData!.shapeType === "polyline") {
        // 绘制折线
        this.drawPolyline();
      } else if (this.drawData!.shapeType === "points") {
        // 绘制点集
        this.drawPoints();
      } else if (this.drawData!.shapeType === "ellipse") {
        // 绘制椭圆
        this.drawEllipse();
        // 显示形状尺寸
        this.shapeSizeElement = displayShapeSize(this.canvas, this.text);
      } else if (this.drawData!.shapeType === "skeleton") {
        // 绘制骨架
        this.drawSkeleton();
      }

      // 如果不是椭圆形状，设置绘制事件
      if (this.drawData!.shapeType !== "ellipse") {
        this.setupDrawEvents();
      }
    }

    // 记录开始时间
    this.startTimestamp = Date.now();
    // 标记为已初始化
    this.initialized = true;
  }

  /**
   * 构造函数
   * @param onDrawDone 绘制完成回调函数
   * @param canvas SVG画布容器
   * @param text SVG文本容器
   * @param autoborderHandler 自动边界处理器
   * @param geometry 几何信息
   * @param configuration 配置信息
   * 初始化绘制处理器，设置事件监听和初始状态
   */
  public constructor(
    onDrawDone: DrawHandlerImpl["onDrawDoneDefault"],
    canvas: SVG.Container,
    text: SVG.Container,
    autoborderHandler: AutoborderHandler,
    geometry: Geometry,
    configuration: Configuration
  ) {
    // 初始化自动边界处理器
    this.autoborderHandler = autoborderHandler;
    // 设置控制点大小
    this.controlPointsSize = configuration.controlPointsSize!;
    // 设置选中形状透明度
    this.selectedShapeOpacity = configuration.selectedShapeOpacity!;
    // 设置边框颜色
    this.outlinedBorders = configuration.outlinedBorders || "black";
    // 初始化自动边界标志
    this.autobordersEnabled = false;
    // 初始化隐藏标志
    this.isHidden = false;
    // 记录开始时间
    this.startTimestamp = Date.now();
    // 设置默认绘制完成回调
    this.onDrawDoneDefault = onDrawDone;
    // 设置画布
    this.canvas = canvas;
    // 设置文本容器
    this.text = text;
    // 初始化标志
    this.initialized = false;
    // 取消标志
    this.canceled = false;
    // 初始化绘制数据
    this.drawData = null;
    // 设置几何信息
    this.geometry = geometry;
    // 创建十字线
    this.crosshair = new Crosshair();
    // 初始化绘制实例
    this.drawInstance = null;
    // 初始化点组
    this.pointsGroup = null;
    // 初始化光标位置
    this.cursorPosition = {
      x: 0,
      y: 0,
    };
    // 初始化形状尺寸显示元素
    this.shapeSizeElement = null;

    // 设置鼠标移动事件处理，用于更新光标位置和十字线
    this.canvas.on("mousemove.crosshair", (e: MouseEvent): void => {
      // 转换鼠标坐标到SVG坐标系
      const [x, y] = translateToSVG(this.canvas.node as any as SVGSVGElement, [
        e.clientX,
        e.clientY,
      ]);
      // 更新光标位置
      this.cursorPosition = { x, y };
      // 更新十字线位置
      if (this.crosshair) {
        this.crosshair.move(x, y);
      }
    });
  }

  /**
   * 设置点的描边样式
   * @param point 需要设置样式的SVG点元素
   * 根据隐藏状态设置点的描边颜色和填充透明度
   */
  private strokePoint(point: SVG.Element): void {
    // 根据隐藏状态设置描边颜色
    point.attr("stroke", this.isHidden ? "none" : CIRCLE_STROKE);
    // 根据隐藏状态设置填充透明度
    point.fill({ opacity: this.isHidden ? 0 : 1 });
  }

  /**
   * 更新隐藏状态
   * @param value 是否隐藏
   * 更新隐藏状态并设置画布的指针事件属性
   */
  private updateHidden(value: boolean) {
    // 更新隐藏状态
    this.isHidden = value;

    // 根据隐藏状态设置画布的指针事件
    if (value) {
      // 隐藏时禁用指针事件
      this.canvas.attr("pointer-events", "none");
    } else {
      // 显示时启用指针事件
      this.canvas.attr("pointer-events", "all");
    }
  }

  /**
   * 配置绘制处理器
   * @param configuration 配置对象，包含控制点大小、透明度等设置
   * 根据配置更新绘制处理器的各项参数和样式
   */
  public configure(configuration: Configuration): void {
    // 设置控制点大小
    this.controlPointsSize = configuration.controlPointsSize!;
    // 设置选中形状透明度
    this.selectedShapeOpacity = configuration.selectedShapeOpacity!;
    // 设置边框颜色，默认为黑色
    this.outlinedBorders = configuration.outlinedBorders || "black";
    // 如果隐藏状态发生变化，更新隐藏状态
    if (this.isHidden !== configuration.hideEditedObject) {
      this.updateHidden(configuration.hideEditedObject!);
    }

    // 判断是否为可填充的矩形（经典绘制方法或初始状态）
    const isFillableRect =
      this.drawData &&
      this.drawData.shapeType === "rectangle" &&
      (this.drawData.rectDrawingMethod === RectDrawingMethod.CLASSIC ||
        this.drawData.initialState);

    // 判断是否为多边形
    const isFilalblePolygon = this.drawData && this.drawData.shapeType === "polygon";

    // 如果绘制实例存在且形状可填充，设置填充透明度
    if (this.drawInstance && (isFillableRect || isFilalblePolygon)) {
      this.drawInstance.fill({
        opacity: configuration.hideEditedObject ? 0 : configuration.selectedShapeOpacity,
      });
    }

    // 如果是多边形，处理多边形点的样式
    if (this.drawInstance && isFilalblePolygon) {
      // 获取绘制处理器
      const paintHandler = this.drawInstance.remember("_paintHandler");
      if (paintHandler) {
        // 遍历所有点并设置样式
        for (const point of (paintHandler as any).set.members) {
          this.strokePoint(point);
        }
      }
    }

    // 如果绘制实例存在且有描边，设置描边颜色
    if (this.drawInstance && this.drawInstance.attr("stroke")) {
      this.drawInstance.attr(
        "stroke",
        configuration.hideEditedObject ? "none" : this.outlinedBorders
      );
    }

    // 如果点组存在且有描边，设置点组的描边颜色
    if (this.pointsGroup && this.pointsGroup.attr("stroke")) {
      this.pointsGroup.attr(
        "stroke",
        configuration.hideEditedObject ? "none" : this.outlinedBorders
      );
    }

    // 更新自动边界标志
    this.autobordersEnabled = configuration.autoborders!;
    // 如果绘制实例存在且不是初始状态，处理自动边界
    if (this.drawInstance && !this.drawData!.initialState) {
      if (this.autobordersEnabled) {
        // 启用自动边界
        this.autoborderHandler.autoborder(true, this.drawInstance, this.drawData!.redraw);
      } else {
        // 禁用自动边界
        this.autoborderHandler.autoborder(false);
      }
    }
  }

  /**
   * 变换几何属性
   * @param geometry 几何信息，包含缩放比例等
   * 根据新的几何信息更新绘制实例和十字线的缩放比例
   */
  public transform(geometry: Geometry): void {
    // 更新几何信息
    this.geometry = geometry;

    // 如果形状大小元素和绘制实例存在，且形状类型为矩形或椭圆，更新形状大小元素
    if (
      this.shapeSizeElement &&
      this.drawInstance &&
      ["rectangle", "ellipse"].includes(this.drawData!.shapeType!)
    ) {
      this.shapeSizeElement.update(this.drawInstance);
    }

    // 如果十字线存在，更新其缩放比例
    if (this.crosshair) {
      this.crosshair.scale(this.geometry.scale);
    }

    // 如果点组存在，更新其描边宽度和点的样式
    if (this.pointsGroup) {
      // 设置点组的描边宽度（根据缩放比例调整）
      this.pointsGroup.attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
      });

      // 遍历点组中的所有点，更新其样式
      for (const point of this.pointsGroup.children()) {
        point.attr({
          "stroke-width": consts.POINTS_STROKE_WIDTH / geometry.scale,
          r: this.controlPointsSize / geometry.scale,
        });
      }
    }

    // 如果绘制实例存在，更新其描边宽度和点的样式
    if (this.drawInstance) {
      // 设置绘制实例的描边宽度（根据缩放比例调整）
      this.drawInstance.attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / geometry.scale,
      });

      // 获取绘制处理器
      const paintHandler = this.drawInstance.remember("_paintHandler");
      if (paintHandler) {
        // 遍历绘制处理器中的所有点，更新其样式
        for (const point of (paintHandler as any).set.members) {
          this.strokePoint(point);
          point.attr("stroke-width", `${consts.POINTS_STROKE_WIDTH / geometry.scale}`);
          point.attr("r", `${this.controlPointsSize / geometry.scale}`);
        }
      }
    }
  }

  /**
   * 开始或释放绘制
   * @param drawData 绘制数据，包含启用状态、形状类型等
   * @param geometry 几何信息，包含缩放比例等
   * 根据启用状态执行相应的绘制操作
   */
  public draw(drawData: DrawData, geometry: Geometry): void {
    // 更新几何信息
    this.geometry = geometry;

    // 如果启用绘制
    if (drawData.enabled) {
      // 重置取消标志
      this.canceled = false;
      // 设置绘制数据
      this.drawData = drawData;
      // 初始化绘制
      this.initDrawing();
      // 开始绘制
      this.startDraw();
    } else {
      // 释放当前绘制
      this.release();
      // 设置绘制数据
      this.drawData = drawData;
    }
  }

  /**
   * 取消绘制
   * 设置取消标志并释放当前绘制
   */
  public cancel(): void {
    // 设置取消标志
    this.canceled = true;
    // 释放当前绘制
    this.release();
  }
}
