// Copyright (C) 2020-2022 Intel Corporation
//
// SPDX-License-Identifier: MIT

import type * as SVG from "svg.js";

import consts from "../consts/consts";

/**
 * 十字准线类，用于在画布上显示可移动的十字准线
 * 提供显示、隐藏、移动和缩放十字准线的功能
 */
export default class Crosshair {
  /** 水平线对象 */
  private x: SVG.Line | null;
  /** 垂直线对象 */
  private y: SVG.Line | null;
  /** 画布容器引用 */
  private canvas: SVG.Container | null;

  /**
   * 构造函数，初始化十字准线对象
   */
  public constructor() {
    // 初始化所有属性为null
    this.x = null;
    this.y = null;
    this.canvas = null;
  }

  /**
   * 在指定位置显示十字准线
   * @param canvas - SVG画布容器
   * @param x - 十字准线中心点的X坐标
   * @param y - 十字准线中心点的Y坐标
   * @param scale - 缩放比例，用于调整线条宽度
   */
  public show(canvas: SVG.Container, x: number, y: number, scale: number): void {
    // 如果当前已存在十字准线且画布不同，先移除旧的十字准线
    if (this.canvas && this.canvas !== canvas) {
      if (this.x) this.x.remove();
      if (this.y) this.y.remove();
      this.x = null;
      this.y = null;
    }

    // 保存当前画布引用
    this.canvas = canvas;
    // 创建水平线，从画布左侧到右侧，穿过指定Y坐标
    this.x = this.canvas
      .line(0, y, this.canvas.node.clientWidth, y)
      .attr({
        // 根据缩放比例设置线条宽度
        "stroke-width": consts.BASE_STROKE_WIDTH / (2 * scale),
      })
      // 添加CSS类名用于样式设置
      .addClass("cvat_canvas_crosshair");

    // 创建垂直线，从画布顶部到底部，穿过指定X坐标
    this.y = this.canvas
      .line(x, 0, x, this.canvas.node.clientHeight)
      .attr({
        // 根据缩放比例设置线条宽度
        "stroke-width": consts.BASE_STROKE_WIDTH / (2 * scale),
      })
      // 添加CSS类名用于样式设置
      .addClass("cvat_canvas_crosshair");
  }

  /**
   * 隐藏十字准线，移除所有线条并重置引用
   */
  public hide(): void {
    // 如果水平线存在，移除它并重置引用
    if (this.x) {
      this.x.remove();
      this.x = null;
    }

    // 如果垂直线存在，移除它并重置引用
    if (this.y) {
      this.y.remove();
      this.y = null;
    }

    // 重置画布引用
    this.canvas = null;
  }

  /**
   * 移动十字准线到新位置
   * @param x - 新的X坐标
   * @param y - 新的Y坐标
   */
  public move(x: number, y: number): void {
    // 如果水平线存在，更新其Y坐标
    if (this.x) {
      this.x.attr({ y1: y, y2: y });
    }

    // 如果垂直线存在，更新其X坐标
    if (this.y) {
      this.y.attr({ x1: x, x2: x });
    }
  }

  /**
   * 根据缩放比例调整十字准线的线条宽度
   * @param scale - 新的缩放比例
   */
  public scale(scale: number): void {
    // 如果水平线存在，更新其线条宽度
    if (this.x) {
      this.x.attr("stroke-width", consts.BASE_STROKE_WIDTH / (2 * scale));
    }

    // 如果垂直线存在，更新其线条宽度
    if (this.y) {
      this.y.attr("stroke-width", consts.BASE_STROKE_WIDTH / (2 * scale));
    }
  }
}
