// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type * as SVG from "svg.js";

import consts from "../consts/consts";
import type { Geometry } from "../core/canvasModel";
import { translateToSVG } from "../utils/shared";

/**
 * 区域选择器接口
 * 定义了区域选择器的基本功能，包括启用/禁用选择、取消选择和几何变换
 */
export interface RegionSelector {
  /**
   * 启用或禁用区域选择功能
   * @param enabled 是否启用区域选择功能
   */
  select(enabled: boolean): void;

  /**
   * 取消当前选择操作
   * 清除选择状态并重置相关UI元素
   */
  cancel(): void;

  /**
   * 更新几何信息
   * 根据新的几何参数调整选择器的显示和交互
   * @param geometry 新的几何信息，包含缩放比例等参数
   */
  transform(geometry: Geometry): void;
}

/**
 * 区域选择器实现类
 * 提供在SVG画布上通过拖拽选择矩形区域的功能
 * 支持单点选择和区域选择，选择完成后通过回调函数返回选择区域的坐标
 */
export class RegionSelectorImpl implements RegionSelector {
  /** 区域选择完成回调函数，接收选择区域的坐标点数组 */
  private onRegionSelected: (points?: number[]) => void;
  /** 几何信息，包含缩放比例和偏移量等参数 */
  private geometry: Geometry;
  /** SVG画布容器 */
  private canvas: SVG.Container;
  /** 选择矩形元素 */
  private selectionRect: SVG.Rect | null;
  /** 选择开始点坐标 */
  private startSelectionPoint: {
    x: number;
    y: number;
  };

  /**
   * 根据当前鼠标位置和初始选择点计算选择框的边界坐标
   * @param event 鼠标事件对象，包含当前鼠标位置信息
   * @returns 选择框的边界坐标，包含左上角(xtl, ytl)和右下角(xbr, ybr)坐标
   */
  private getSelectionBox(event: MouseEvent): {
    xtl: number;
    ytl: number;
    xbr: number;
    ybr: number;
  } {
    // 将屏幕坐标转换为SVG坐标
    const point = translateToSVG(this.canvas.node as any as SVGSVGElement, [
      event.clientX,
      event.clientY,
    ]);
    // 记录当前鼠标位置作为选择结束点
    const stopSelectionPoint = {
      x: point[0],
      y: point[1],
    };

    // 计算并返回选择框的边界坐标
    return {
      xtl: Math.min(this.startSelectionPoint.x, stopSelectionPoint.x), // 左上角X坐标
      ytl: Math.min(this.startSelectionPoint.y, stopSelectionPoint.y), // 左上角Y坐标
      xbr: Math.max(this.startSelectionPoint.x, stopSelectionPoint.x), // 右下角X坐标
      ybr: Math.max(this.startSelectionPoint.y, stopSelectionPoint.y), // 右下角Y坐标
    };
  }

  /**
   * 鼠标移动事件处理函数
   * 在选择过程中实时更新选择框的大小和位置
   * @param event 鼠标事件对象，包含当前鼠标位置信息
   */
  private onMouseMove = (event: MouseEvent): void => {
    // 检查是否存在选择框
    if (this.selectionRect) {
      // 计算当前选择框的边界坐标
      const box = this.getSelectionBox(event);

      // 更新选择框的位置和大小属性
      this.selectionRect.attr({
        x: box.xtl, // 左上角X坐标
        y: box.ytl, // 左上角Y坐标
        width: box.xbr - box.xtl, // 宽度
        height: box.ybr - box.ytl, // 高度
      });
    }
  };

  /**
   * 鼠标按下事件处理函数
   * 开始区域选择，记录初始位置并创建选择框
   * @param event 鼠标事件对象，包含按下位置信息
   */
  private onMouseDown = (event: MouseEvent): void => {
    // 检查是否没有选择框且未按下Alt键
    if (!this.selectionRect && !event.altKey) {
      // 将屏幕坐标转换为SVG坐标
      const point = translateToSVG(this.canvas.node as any as SVGSVGElement, [
        event.clientX,
        event.clientY,
      ]);
      // 记录选择开始点坐标
      this.startSelectionPoint = {
        x: point[0],
        y: point[1],
      };

      // 创建选择矩形元素
      this.selectionRect = this.canvas
        .rect()
        .attr({
          // 根据缩放比例设置边框宽度
          "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        })
        .addClass("cvat_canvas_shape_region_selection");
      // 设置选择框的初始位置和大小
      this.selectionRect.attr({ ...this.startSelectionPoint, width: 1, height: 1 });
    }
  };

  /**
   * 鼠标释放事件处理函数
   * 完成区域选择，计算选择区域坐标并调用回调函数
   */
  private onMouseUp = (): void => {
    // 获取几何偏移量
    const { offset } = this.geometry;
    // 检查是否存在选择框
    if (this.selectionRect) {
      // 获取选择框的边界框信息
      const { w, h, x, y, x2, y2 } = this.selectionRect.bbox();
      // 移除选择框
      this.selectionRect.remove();
      this.selectionRect = null;

      // 根据选择框大小判断是单点选择还是区域选择
      if (w <= 1 && h <= 1) {
        // 单点选择，返回单个点坐标
        this.onRegionSelected([x - offset, y - offset]);
      } else {
        // 区域选择，返回矩形区域坐标（左上角和右下角）
        this.onRegionSelected([x - offset, y - offset, x2 - offset, y2 - offset]);
      }
    }
  };

  /**
   * 开始区域选择功能
   * 添加鼠标事件监听器以启用选择交互
   */
  private startSelection(): void {
    // 添加鼠标移动事件监听器
    this.canvas.node.addEventListener("mousemove", this.onMouseMove);
    // 添加鼠标按下事件监听器
    this.canvas.node.addEventListener("mousedown", this.onMouseDown);
    // 添加鼠标释放事件监听器
    this.canvas.node.addEventListener("mouseup", this.onMouseUp);
  }

  /**
   * 停止区域选择功能
   * 移除鼠标事件监听器以禁用选择交互
   */
  private stopSelection(): void {
    // 移除鼠标移动事件监听器
    this.canvas.node.removeEventListener("mousemove", this.onMouseMove);
    // 移除鼠标按下事件监听器
    this.canvas.node.removeEventListener("mousedown", this.onMouseDown);
    // 移除鼠标释放事件监听器
    this.canvas.node.removeEventListener("mouseup", this.onMouseUp);
  }

  /**
   * 释放区域选择资源
   * 停止选择功能并清理相关资源
   */
  private release(): void {
    // 停止选择功能
    this.stopSelection();
  }

  /**
   * 创建区域选择器实例
   * @param onRegionSelected 区域选择完成回调函数，接收选择区域的坐标点数组
   * @param canvas SVG画布容器
   * @param geometry 几何信息，包含缩放比例和偏移量等参数
   */
  public constructor(
    onRegionSelected: RegionSelectorImpl["onRegionSelected"],
    canvas: SVG.Container,
    geometry: Geometry
  ) {
    // 设置选择完成回调函数
    this.onRegionSelected = onRegionSelected;
    // 设置几何信息
    this.geometry = geometry;
    // 设置SVG画布容器
    this.canvas = canvas;
    // 初始化选择框为空
    this.selectionRect = null;
    // 初始化选择开始点坐标
    this.startSelectionPoint = { x: 0, y: 0 };
  }

  /**
   * 启用或禁用区域选择功能
   * @param enabled 是否启用区域选择功能
   */
  public select(enabled: boolean): void {
    if (enabled) {
      // 启用选择功能
      this.startSelection();
    } else {
      // 禁用选择功能
      this.release();
    }
  }

  /**
   * 取消当前选择操作
   * 清除选择状态并调用回调函数通知选择已取消
   */
  public cancel(): void {
    // 释放选择资源
    this.release();
    // 调用回调函数，不传递参数表示选择已取消
    this.onRegionSelected();
  }

  /**
   * 更新几何信息并调整选择框样式
   * 根据新的几何缩放比例调整选择框的边框宽度
   * @param geometry 新的几何信息，包含缩放比例等参数
   */
  public transform(geometry: Geometry): void {
    // 更新几何信息
    this.geometry = geometry;
    // 如果存在选择框，根据缩放比例调整边框宽度
    if (this.selectionRect) {
      this.selectionRect.attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / geometry.scale,
      });
    }
  }
}
