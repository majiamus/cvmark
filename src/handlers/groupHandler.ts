// Copyright (C) 2019-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type { GroupData } from "../core/canvasModel";
import type { ObjectSelector, SelectionFilter } from "../selector/objectSelector";

/**
 * 分组处理器接口，定义了形状分组操作的基本方法
 * 用于管理多个形状的选择、分组和取消分组操作
 */
export interface GroupHandler {
  /**
   * 启用或禁用分组模式
   * @param groupData - 分组数据，包含是否启用分组的状态信息
   * @param selectionFilter - 选择过滤器，用于过滤可选择的形状
   */
  group(groupData: GroupData, selectionFilter: SelectionFilter): void;

  /**
   * 选择指定对象进行分组
   * @param state - 要选择的对象状态
   */
  select(state: any): void;

  /**
   * 取消分组操作，释放资源并重置状态
   */
  cancel(): void;
}

/**
 * 分组处理器实现类，负责管理形状的分组操作
 * 提供形状选择、分组创建和取消分组等功能
 */
export class GroupHandlerImpl implements GroupHandler {
  /** 选择完成回调函数，接收选中的对象数组和操作持续时间 */
  private onSelectDone: (objects?: any[], duration?: number) => void;
  /** 对象选择器，用于处理形状的选择逻辑 */
  private selector: ObjectSelector;
  /** 标记是否已初始化分组状态 */
  private initialized: boolean;
  /** 待分组的对象状态数组 */
  private statesToBeGrouped: any[];
  /** 分组操作开始的时间戳 */
  private startTimestamp: number;

  /**
   * 释放分组资源并重置状态
   * 禁用选择器并将初始化状态设为false
   */
  private release(): void {
    // 禁用对象选择器
    this.selector.disable();
    // 重置初始化状态
    this.initialized = false;
  }

  /**
   * 初始化分组操作
   * @param selectionFilter - 选择过滤器，用于过滤可选择的形状
   */
  private initGrouping(selectionFilter: SelectionFilter): void {
    // 清空待分组对象数组
    this.statesToBeGrouped = [];
    // 启用对象选择器，设置选择回调函数和过滤器
    this.selector.enable((selected) => {
      // 将选中的对象保存到待分组数组
      this.statesToBeGrouped = selected;
    }, selectionFilter);
    // 标记为已初始化状态
    this.initialized = true;
    // 记录分组操作开始时间
    this.startTimestamp = Date.now();
  }

  /**
   * 关闭分组操作并处理结果
   * 释放资源，并根据选中的对象调用完成回调
   */
  private closeGrouping(): void {
    // 检查是否已初始化分组状态
    if (this.initialized) {
      // 保存当前待分组对象数组
      const { statesToBeGrouped } = this;
      // 释放分组资源
      this.release();
      // 如果有选中的对象，调用回调并传递对象数组和操作持续时间
      if (statesToBeGrouped.length) {
        this.onSelectDone(statesToBeGrouped, Date.now() - this.startTimestamp);
      }
      // 如果没有选中对象，调用回调但不传递参数
      else {
        this.onSelectDone();
      }
    }
  }

  /**
   * 创建分组处理器实例
   * @param onSelectDone - 选择完成回调函数，接收选中的对象数组和操作持续时间
   * @param selector - 对象选择器实例，用于处理形状的选择逻辑
   */
  public constructor(
    onSelectDone: GroupHandlerImpl["onSelectDone"],
    selector: ObjectSelector
  ) {
    // 保存选择完成回调函数
    this.onSelectDone = onSelectDone;
    // 保存对象选择器实例
    this.selector = selector;
    // 初始化待分组对象数组为空数组
    this.statesToBeGrouped = [];
    // 初始化分组状态为未初始化
    this.initialized = false;
    // 记录当前时间作为初始时间戳
    this.startTimestamp = Date.now();
  }

  /**
   * 启用或禁用分组模式
   * @param groupData - 分组数据，包含是否启用分组的状态信息
   * @param selectionFilter - 选择过滤器，用于过滤可选择的形状
   */
  public group(groupData: GroupData, selectionFilter: SelectionFilter): void {
    // 如果启用分组模式，初始化分组操作
    if (groupData.enabled) {
      this.initGrouping(selectionFilter);
    }
    // 如果禁用分组模式，关闭分组操作
    else {
      this.closeGrouping();
    }
  }

  /**
   * 选择指定对象进行分组
   * @param objectState - 要选择的对象状态
   */
  public select(objectState: any): void {
    // 将对象状态添加到选择器中
    this.selector.push(objectState);
  }

  /**
   * 取消分组操作
   * 释放资源并调用选择完成回调，不传递任何参数表示取消操作
   */
  public cancel(): void {
    // 释放分组资源
    this.release();
    // 调用选择完成回调，不传递参数表示取消操作
    this.onSelectDone();
  }
}
