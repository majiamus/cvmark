// Copyright (C) 2019-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type * as SVG from "svg.js";

import type { MergeData } from "../core/canvasModel";

/**
 * 合并处理器接口，定义处理形状合并操作的方法
 * 提供合并、选择、取消和重复选择等功能
 */
export interface MergeHandler {
  /**
   * 执行形状合并操作
   * @param mergeData - 包含合并所需数据的对象
   */
  merge(mergeData: MergeData): void;

  /**
   * 选择指定的状态对象
   * @param state - 要选择的状态对象
   */
  select(state: any): void;

  /**
   * 取消当前操作
   * 清理临时状态和资源
   */
  cancel(): void;

  /**
   * 重复上一次的选择操作
   * 用于快速重新应用之前的选择
   */
  repeatSelection(): void;
}

/**
 * 合并处理器实现类
 * 负责处理形状合并操作，包括选择、高亮、约束管理和合并执行
 * 实现了MergeHandler接口定义的所有方法
 */
export class MergeHandlerImpl implements MergeHandler {
  /** 合并完成时的回调函数，接收合并后的对象数组和操作持续时间 */
  private onMergeDone: (objects: any[] | null, duration?: number) => void;

  /** 查找对象的回调函数，处理鼠标事件以查找形状 */
  private onFindObject: (event: MouseEvent) => void;

  /** 操作开始时间戳，用于计算操作持续时间 */
  private startTimestamp: number;

  /** SVG画布容器，用于渲染和操作形状 */
  private canvas: SVG.Container;

  /** 初始化状态标志，指示处理器是否已初始化 */
  private initialized: boolean;

  /** 待合并的状态对象数组，存储当前正在合并的形状状态 */
  private statesToBeMerged: any[];

  /** 高亮形状记录，按形状ID索引的形状对象映射 */
  private highlightedShapes: Record<number, SVG.Shape>;

  /** 合并约束条件，限制可合并形状的标签ID和类型，null表示无约束 */
  private constraints: {
    labelID: number;
    shapeType: string;
  } | null;

  /**
   * 添加合并约束条件
   * 基于第一个待合并形状设置标签ID和形状类型约束
   */
  private addConstraints(): void {
    // 获取第一个待合并的形状
    const shape = this.statesToBeMerged[0];
    // 设置约束条件，确保后续合并的形状具有相同的标签ID和形状类型
    this.constraints = {
      labelID: shape.label.id,
      shapeType: shape.shapeType,
    };
  }

  /**
   * 移除合并约束条件
   * 清除当前设置的标签ID和形状类型约束
   */
  private removeConstraints(): void {
    // 将约束条件设置为null，表示无约束
    this.constraints = null;
  }

  /**
   * 检查状态是否符合约束条件
   * @param state - 要检查的状态对象
   * @returns 如果状态符合约束条件或无约束则返回true，否则返回false
   */
  private checkConstraints(state: any): boolean {
    // 如果没有约束条件，或者状态的标签ID和形状类型与约束匹配，则返回true
    return (
      !this.constraints ||
      (state.label.id === this.constraints.labelID &&
        state.shapeType === this.constraints.shapeType)
    );
  }

  /**
   * 释放合并状态并清理资源
   * 移除事件监听器，清除高亮样式，重置状态变量
   */
  private release(): void {
    // 移除约束条件
    this.removeConstraints();
    // 移除画布点击事件监听器
    this.canvas.node.removeEventListener("click", this.onFindObject);
    // 遍历所有待合并状态，移除高亮样式
    for (const state of this.statesToBeMerged) {
      // 获取对应的高亮形状
      const shape = this.highlightedShapes[state.clientID];
      // 移除合并高亮样式类
      shape.removeClass("cvat_canvas_shape_merging");
    }
    // 清空待合并状态数组
    this.statesToBeMerged = [];
    // 清空高亮形状记录
    this.highlightedShapes = {};
    // 重置初始化状态
    this.initialized = false;
  }

  /**
   * 初始化合并操作
   * 添加事件监听器，记录开始时间，设置初始化标志
   */
  private initMerging(): void {
    // 添加画布点击事件监听器，用于查找形状
    this.canvas.node.addEventListener("click", this.onFindObject);
    // 记录操作开始时间戳
    this.startTimestamp = Date.now();
    // 设置初始化标志为true
    this.initialized = true;
  }

  /**
   * 关闭合并操作并处理结果
   * 根据待合并状态数量决定是否执行合并或取消操作
   */
  private closeMerging(): void {
    // 检查是否已初始化合并操作
    if (this.initialized) {
      // 保存当前待合并状态数组引用
      const { statesToBeMerged } = this;
      // 释放合并状态和资源
      this.release();

      // 如果有多个待合并状态，执行合并操作
      if (statesToBeMerged.length > 1) {
        // 计算操作耗时并调用合并完成回调
        this.onMergeDone(statesToBeMerged, Date.now() - this.startTimestamp);
      } else {
        // 状态不足，取消合并操作
        this.onMergeDone(null);
        // 这里存在一个循环调用链：
        // onMergeDone => controller => model => view => closeMerging
        // 一次closeMerging调用是无用的，但这是正常的
      }
    }
  }

  /**
   * 创建合并处理器实例
   * @param onMergeDone 合并完成时的回调函数
   * @param onFindObject 查找对象时的回调函数
   * @param canvas SVG画布容器
   */
  public constructor(
    onMergeDone: MergeHandlerImpl["onMergeDone"],
    onFindObject: MergeHandlerImpl["onFindObject"],
    canvas: SVG.Container
  ) {
    // 初始化回调函数
    this.onMergeDone = onMergeDone;
    this.onFindObject = onFindObject;
    // 记录操作开始时间戳
    this.startTimestamp = Date.now();
    // 保存SVG画布引用
    this.canvas = canvas;
    // 初始化数据结构
    this.statesToBeMerged = [];
    this.highlightedShapes = {};
    this.constraints = null;
    // 设置初始化状态为未完成
    this.initialized = false;
  }

  /**
   * 处理合并操作的启用和禁用
   * 根据mergeData.enabled状态决定初始化或关闭合并操作
   * @param mergeData 包含合并操作状态的数据对象
   */
  public merge(mergeData: MergeData): void {
    // 如果启用合并操作，初始化合并流程
    if (mergeData.enabled) {
      this.initMerging();
    } else {
      // 否则关闭合并操作
      this.closeMerging();
    }
  }

  /**
   * 选择或取消选择对象状态进行合并操作
   * 根据对象是否已在待合并列表中决定添加或移除
   * @param objectState 要选择或取消选择的对象状态
   */
  public select(objectState: any): void {
    // 检查对象类型，掩码类型不能参与合并
    if (objectState.shapeType === "mask") {
      // 掩码无法合并
      return;
    }

    // 获取当前待合并状态的所有客户端ID和帧号
    const stateIndexes = this.statesToBeMerged.map((state): number => state.clientID);
    const stateFrames = this.statesToBeMerged.map((state): number => state.frame);
    // 检查当前对象是否已在待合并列表中
    const includes = stateIndexes.indexOf(objectState.clientID);

    if (includes !== -1) {
      // 对象已在列表中，执行取消选择操作
      // 获取高亮形状引用
      const shape = this.highlightedShapes[objectState.clientID];
      // 从待合并列表中移除该对象
      this.statesToBeMerged.splice(includes, 1);

      if (shape) {
        // 移除高亮记录
        delete this.highlightedShapes[objectState.clientID];
        // 移除高亮样式类
        shape.removeClass("cvat_canvas_shape_merging");
      }

      // 如果待合并列表为空，移除约束条件
      if (!this.statesToBeMerged.length) {
        this.removeConstraints();
      }
    } else {
      // 对象不在列表中，尝试添加到待合并列表
      // 从画布中选择对应的形状元素
      const shape = this.canvas
        .select(`#cvat_canvas_shape_${objectState.clientID}`)
        .first();

      // 检查形状存在、符合约束条件且不在同一帧
      if (
        shape &&
        this.checkConstraints(objectState) &&
        !stateFrames.includes(objectState.frame)
      ) {
        // 添加到待合并列表
        this.statesToBeMerged.push(objectState);
        // 记录高亮形状引用
        this.highlightedShapes[objectState.clientID] = shape;
        // 添加高亮样式类
        shape.addClass("cvat_canvas_shape_merging");

        // 如果是第一个选中的对象，添加约束条件
        if (this.statesToBeMerged.length === 1) {
          this.addConstraints();
        }
      }
    }
  }

  /**
   * 重复应用选择高亮效果
   * 遍历当前待合并状态列表，重新应用高亮样式
   */
  public repeatSelection(): void {
    // 遍历所有待合并状态对象
    for (const objectState of this.statesToBeMerged) {
      // 从画布中选择对应的形状元素
      const shape = this.canvas
        .select(`#cvat_canvas_shape_${objectState.clientID}`)
        .first();
      if (shape) {
        // 更新高亮形状引用
        this.highlightedShapes[objectState.clientID] = shape;
        // 应用高亮样式类
        shape.addClass("cvat_canvas_shape_merging");
      }
    }
  }

  /**
   * 取消当前合并操作
   * 释放所有资源并通知合并完成（结果为null）
   */
  public cancel(): void {
    // 释放合并状态和相关资源
    this.release();
    // 通知合并操作取消（传入null表示取消）
    this.onMergeDone(null);
    // 这里存在一个循环调用链：
    // onMergeDone => controller => model => view => closeMerging
    // 一次closeMerging调用是无用的，但这是正常的
  }
}
