// Copyright (C) 2019-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type * as SVG from "svg.js";

import type { SplitData } from "../core/canvasModel";

/**
 * 分割处理器接口，定义了形状分割的基本操作
 */
export interface SplitHandler {
  /**
   * 启动或停止分割操作
   * @param splitData - 分割操作的数据，包含启用状态和其他配置
   */
  split(splitData: SplitData): void;

  /**
   * 选择要分割的对象
   * @param state - 包含对象类型和ID的状态信息
   */
  select(state: any): void;

  /**
   * 取消当前的分割操作
   */
  cancel(): void;
}

/**
 * 分割处理器实现类，提供形状分割功能
 * 通过交互式UI和事件处理，允许用户选择形状进行分割操作
 */
export class SplitHandlerImpl implements SplitHandler {
  /** 分割完成时的回调函数，用于通知分割结果和耗时 */
  private onSplitDone: (object?: any, duration?: number) => void;
  /** 查找对象的回调函数，用于在鼠标移动时查找形状 */
  private onFindObject: (event: MouseEvent) => void;
  /** SVG画布容器，用于渲染和操作形状 */
  private canvas: SVG.Container;
  /** 当前高亮显示的形状，用户点击后将被分割 */
  private highlightedShape: SVG.Shape | null;
  /** 分割器是否已初始化的标志 */
  private initialized: boolean;
  /** 分割操作是否已完成的标志 */
  private splitDone: boolean;
  /** 分割操作开始的时间戳，用于计算操作耗时 */
  private startTimestamp: number;

  /**
   * 重置当前高亮形状的状态
   * 移除高亮样式和事件监听器，并将高亮形状设为null
   */
  private resetShape(): void {
    if (this.highlightedShape) {
      // 移除高亮样式类
      this.highlightedShape.removeClass("cvat_canvas_shape_splitting");
      // 移除点击事件监听器
      this.highlightedShape.off("click.split");
      // 清空高亮形状引用
      this.highlightedShape = null;
    }
  }

  /**
   * 释放分割器资源
   * 重置形状状态，移除事件监听器，并标记为未初始化
   */
  private release(): void {
    if (this.initialized) {
      // 重置高亮形状
      this.resetShape();
      // 移除鼠标移动事件监听器
      this.canvas.node.removeEventListener("mousemove", this.findObject);
      // 标记为未初始化状态
      this.initialized = false;
    }
  }

  /**
   * 初始化分割操作
   * 添加事件监听器，设置状态标志，并记录开始时间
   */
  private initSplitting(): void {
    // 添加鼠标移动事件监听器，用于查找形状
    this.canvas.node.addEventListener("mousemove", this.findObject);
    // 标记为已初始化
    this.initialized = true;
    // 重置分割完成标志
    this.splitDone = false;
    // 记录操作开始时间
    this.startTimestamp = Date.now();
  }

  /**
   * 关闭分割操作
   * 如果没有完成分割，则调用回调函数，并释放资源
   */
  private closeSplitting(): void {
    // Split done is true if an object was split
    // Split also can be called with { enabled: false } without splitting an object
    // 如果没有完成分割操作，则通知回调函数
    if (!this.splitDone) {
      this.onSplitDone(null);
    }
    // 释放资源
    this.release();
  }

  /**
   * 查找对象事件处理器
   * 在鼠标移动时重置当前高亮形状，并调用回调函数查找新形状
   * @param e - 鼠标移动事件
   */
  private findObject = (e: MouseEvent): void => {
    // 重置当前高亮形状
    this.resetShape();
    // 调用回调函数查找鼠标下的形状
    this.onFindObject(e);
  };

  /**
   * 创建分割处理器实例
   * @param onSplitDone - 分割完成时的回调函数，接收分割结果和耗时
   * @param onFindObject - 查找对象的回调函数，用于在鼠标移动时查找形状
   * @param canvas - SVG画布容器，用于渲染和操作形状
   */
  public constructor(
    onSplitDone: SplitHandlerImpl["onSplitDone"],
    onFindObject: SplitHandlerImpl["onFindObject"],
    canvas: SVG.Container
  ) {
    // 设置回调函数
    this.onSplitDone = onSplitDone;
    this.onFindObject = onFindObject;
    // 设置画布引用
    this.canvas = canvas;
    // 初始化状态变量
    this.highlightedShape = null;
    this.initialized = false;
    this.splitDone = false;
    this.startTimestamp = Date.now();
  }

  /**
   * 启动或停止分割操作
   * 根据splitData.enabled标志决定是初始化分割操作还是关闭分割操作
   * @param splitData - 分割操作的数据，包含启用状态和其他配置
   */
  public split(splitData: SplitData): void {
    if (splitData.enabled) {
      // 启用分割操作
      this.initSplitting();
    } else {
      // 禁用分割操作
      this.closeSplitting();
    }
  }

  /**
   * 选择要分割的对象
   * 当对象类型为'track'时，高亮显示选中的形状并添加点击事件监听器
   * @param state - 包含对象类型和ID的状态信息
   */
  public select(state: any): void {
    // 只处理轨道类型的对象
    if (state.objectType === "track") {
      // 根据clientID查找对应的形状
      const shape = this.canvas.select(`#cvat_canvas_shape_${state.clientID}`).first();
      // 如果形状存在且不是当前高亮的形状
      if (shape && shape !== this.highlightedShape) {
        // 重置当前高亮形状
        this.resetShape();
        // 设置新的高亮形状
        this.highlightedShape = shape;
        // 添加高亮样式类
        this.highlightedShape.addClass("cvat_canvas_shape_splitting");
        // 将高亮形状移到画布顶层
        this.canvas.node.append(this.highlightedShape.node);
        // 添加点击事件监听器，点击时完成分割
        this.highlightedShape.on(
          "click.split",
          (): void => {
            // 标记分割已完成
            this.splitDone = true;
            // 调用回调函数，传递分割结果和耗时
            this.onSplitDone(state, Date.now() - this.startTimestamp);
          },
          { once: true }
        );
      }
    }
  }

  /**
   * 取消当前的分割操作
   * 释放资源并调用回调函数通知取消操作
   */
  public cancel(): void {
    // 释放资源
    this.release();
    // 通知回调函数分割操作已取消
    this.onSplitDone(null);
    // 这里存在一个循环调用:
    // onSplitDone => controller => model => view => closeSplitting
    // 一次调用closeMerging是无用的，但这是可以接受的
  }
}
