import type * as SVG from "svg.js";

import consts from "../consts/consts";
import type { Geometry } from "../core/canvasModel";
import { translateToSVG } from "../utils/shared";

/**
 * 缩放处理器接口，定义了区域缩放的基本操作
 */
export interface ZoomHandler {
  /**
   * 启动区域缩放模式，允许用户通过拖拽选择要放大的区域
   */
  zoom(): void;

  /**
   * 取消当前的区域缩放操作
   */
  cancel(): void;

  /**
   * 应用几何变换，更新缩放处理器的几何状态
   * @param geometry - 新的几何变换参数
   */
  transform(geometry: Geometry): void;
}

/**
 * 缩放处理器实现类，提供区域缩放功能
 * 通过鼠标拖拽选择区域，实现画布的局部放大功能
 */
export class ZoomHandlerImpl implements ZoomHandler {
  /** 区域缩放完成时的回调函数，接收缩放区域的坐标和尺寸 */
  private onZoomRegion: (x: number, y: number, width: number, height: number) => void;
  /** 绑定了this上下文的选择开始事件处理器 */
  private bindedOnSelectStart: (event: MouseEvent) => void;
  /** 绑定了this上下文的选择更新事件处理器 */
  private bindedOnSelectUpdate: (event: MouseEvent) => void;
  /** 绑定了this上下文的选择结束事件处理器 */
  private bindedOnSelectStop: (event: MouseEvent) => void;
  /** 当前画布的几何变换参数 */
  private geometry: Geometry;
  /** SVG画布容器，用于渲染选择框 */
  private canvas: SVG.Container;
  /** 当前显示的选择框矩形，null表示没有选择框 */
  private selectionRect: SVG.Rect | null;
  /** 选择区域的起始点坐标 */
  private startSelectionPoint: {
    x: number;
    y: number;
  };

  /**
   * 处理选择开始事件（鼠标按下）
   * 当左键按下且没有选择框时，创建新的选择框
   * @param event - 鼠标按下事件
   */
  private onSelectStart(event: MouseEvent): void {
    // 只有在没有选择框且按下左键时才开始选择
    if (!this.selectionRect && event.which === 1) {
      // 将鼠标坐标转换为SVG坐标系
      const point = translateToSVG(this.canvas.node as any as SVGSVGElement, [
        event.clientX,
        event.clientY,
      ]);
      // 记录选择起始点
      this.startSelectionPoint = {
        x: point[0],
        y: point[1],
      };

      // 创建选择框矩形
      this.selectionRect = this.canvas.rect().addClass("cvat_canvas_zoom_selection");
      // 设置选择框属性：边框宽度和起始位置
      this.selectionRect.attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        ...this.startSelectionPoint,
      });
    }
  }

  /**
   * 计算选择区域的边界框
   * 根据起始点和当前鼠标位置，返回选择区域的坐标和尺寸
   * @param event - 鼠标事件，用于获取当前鼠标位置
   * @returns 包含选择区域坐标和尺寸的对象
   */
  private getSelectionBox(event: MouseEvent): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    // 将鼠标坐标转换为SVG坐标系
    const point = translateToSVG(this.canvas.node as any as SVGSVGElement, [
      event.clientX,
      event.clientY,
    ]);
    // 记录选择结束点
    const stopSelectionPoint = {
      x: point[0],
      y: point[1],
    };

    // 计算选择区域的左上角和右下角坐标
    const xtl = Math.min(this.startSelectionPoint.x, stopSelectionPoint.x);
    const ytl = Math.min(this.startSelectionPoint.y, stopSelectionPoint.y);
    const xbr = Math.max(this.startSelectionPoint.x, stopSelectionPoint.x);
    const ybr = Math.max(this.startSelectionPoint.y, stopSelectionPoint.y);

    // 返回选择区域的坐标和尺寸
    return {
      x: xtl,
      y: ytl,
      width: xbr - xtl,
      height: ybr - ytl,
    };
  }

  /**
   * 处理选择更新事件（鼠标移动）
   * 在鼠标移动时更新选择框的大小和位置
   * @param event - 鼠标移动事件
   */
  private onSelectUpdate(event: MouseEvent): void {
    // 如果存在选择框，则更新其属性
    if (this.selectionRect) {
      this.selectionRect.attr({
        ...this.getSelectionBox(event),
      });
    }
  }

  /**
   * 处理选择结束事件（鼠标释放）
   * 移除选择框，并根据选择区域大小决定是否执行缩放
   * @param event - 鼠标释放事件
   */
  private onSelectStop(event: MouseEvent): void {
    // 如果存在选择框，则处理选择结束
    if (this.selectionRect) {
      // 获取最终的选择区域
      const box = this.getSelectionBox(event);
      // 移除选择框
      this.selectionRect.remove();
      this.selectionRect = null;
      // 重置起始点
      this.startSelectionPoint = {
        x: 0,
        y: 0,
      };

      // 设置最小选择区域阈值，避免过小的选择区域
      const threshold = 5;
      // 如果选择区域足够大，则执行缩放
      if (box.width > threshold && box.height > threshold) {
        this.onZoomRegion(box.x, box.y, box.width, box.height);
      }
    }
  }

  /**
   * 创建缩放处理器实例
   * @param onZoomRegion - 区域缩放完成时的回调函数，接收缩放区域的坐标和尺寸
   * @param canvas - SVG画布容器，用于渲染选择框
   * @param geometry - 当前画布的几何变换参数
   */
  public constructor(
    onZoomRegion: ZoomHandlerImpl["onZoomRegion"],
    canvas: SVG.Container,
    geometry: Geometry
  ) {
    // 设置回调函数和依赖项
    this.onZoomRegion = onZoomRegion;
    this.canvas = canvas;
    this.geometry = geometry;

    // 初始化状态变量
    this.selectionRect = null;
    this.startSelectionPoint = {
      x: 0,
      y: 0,
    };

    // 绑定事件处理器的this上下文
    this.bindedOnSelectStart = this.onSelectStart.bind(this);
    this.bindedOnSelectUpdate = this.onSelectUpdate.bind(this);
    this.bindedOnSelectStop = this.onSelectStop.bind(this);
  }

  /**
   * 启动区域缩放模式
   * 添加鼠标事件监听器，允许用户通过拖拽选择要放大的区域
   */
  public zoom(): void {
    // 添加鼠标按下事件监听器
    this.canvas.node.addEventListener("mousedown", this.bindedOnSelectStart);
    // 添加鼠标移动事件监听器
    this.canvas.node.addEventListener("mousemove", this.bindedOnSelectUpdate);
    // 添加鼠标释放事件监听器
    this.canvas.node.addEventListener("mouseup", this.bindedOnSelectStop);
  }

  /**
   * 取消当前的区域缩放操作
   * 移除所有鼠标事件监听器，停止区域缩放功能
   */
  public cancel(): void {
    // 移除鼠标按下事件监听器
    this.canvas.node.removeEventListener("mousedown", this.bindedOnSelectStart);
    // 移除鼠标移动事件监听器
    this.canvas.node.removeEventListener("mousemove", this.bindedOnSelectUpdate);
    // 移除鼠标释放事件监听器
    this.canvas.node.removeEventListener("mouseup", this.bindedOnSelectStop);
  }

  /**
   * 应用几何变换，更新缩放处理器的几何状态
   * 更新几何参数并调整选择框的边框宽度以适应新的缩放级别
   * @param geometry - 新的几何变换参数
   */
  public transform(geometry: Geometry): void {
    // 更新几何参数
    this.geometry = geometry;
    // 如果存在选择框，则调整其边框宽度
    if (this.selectionRect) {
      this.selectionRect.style({
        "stroke-width": consts.BASE_STROKE_WIDTH / geometry.scale,
      });
    }
  }
}
