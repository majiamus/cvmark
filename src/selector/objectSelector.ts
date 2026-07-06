// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type * as SVG from "svg.js";

import consts from "../consts/consts";
import type { Geometry } from "../core/canvasModel";
import { expandChannels, imageDataToDataURL, translateToSVG } from "../utils/shared";

/**
 * 对象选择过滤器接口
 * 用于定义对象选择时的过滤条件
 */
export interface SelectionFilter {
  /** 可选择的对象类型数组，如['box', 'polygon'] */
  objectType?: string[];
  /** 可选择的形状类型数组，如['rectangle', 'circle'] */
  shapeType?: string[];
  /** 最大可选择对象数量 */
  maxCount?: number;
}

/**
 * 对象选择器接口
 * 定义了对象选择器的核心功能，包括启用、变换、推送状态、禁用和重置选择
 */
export interface ObjectSelector {
  /**
   * 启用对象选择器
   * @param callback 选择完成后的回调函数，接收选中的对象状态数组
   * @param filter 可选的选择过滤器，用于限制可选择的对象
   */
  enable(callback: (selected: ObjectState[]) => void, filter?: SelectionFilter): void;

  /**
   * 变换选择器的几何属性
   * @param geometry 包含位置、尺寸等几何信息的对象
   */
  transform(geometry: Geometry): void;

  /**
   * 推送对象状态到选择器
   * @param state 要添加的对象状态
   */
  push(state: ObjectState): void;

  /**
   * 禁用对象选择器
   */
  disable(): void;

  /**
   * 重置当前选择状态
   */
  resetSelected(): void;
}

/**
 * 对象状态类型
 * 表示任何对象的状态数据，可以是任何类型的对象
 */
export type ObjectState = any;

/**
 * 对象选择器实现类
 * 提供在SVG画布上选择和管理对象的功能
 * 支持通过拖拽选择框选择多个对象，也支持单击选择单个对象
 * 实现了对象选择、状态管理、外观重置等核心功能
 */
export class ObjectSelectorImpl implements ObjectSelector {
  /** 对象选择过滤器，用于限制可选择的对象 */
  private selectionFilter: SelectionFilter | null;
  /** SVG画布容器，用于渲染和操作形状 */
  private canvas: SVG.Container;
  /** 选择矩形，用于框选多个对象 */
  private selectionRect: SVG.Rect | null;
  /** 几何信息，包含画布的位置和尺寸等属性 */
  private geometry: Geometry;
  /** 选择器是否已启用的标志 */
  private isEnabled: boolean;
  /** 鼠标按下时的位置坐标，用于框选操作 */
  private mouseDownPosition: { x: number; y: number };
  /** 已选择的对象映射，键为对象ID，值为对象状态 */
  private selectedObjects: Record<number, ObjectState>;
  /** 重置对象外观的函数映射，键为对象ID，值为重置函数 */
  private resetAppearance: Record<number, () => void>;
  /** 点击事件处理函数，用于查找点击位置的对象 */
  private findObjectOnClick: (event: MouseEvent) => void;
  /** 获取所有对象状态的函数 */
  private getStates: () => ObjectState[];
  /** 选择完成后的回调函数，接收选中的对象状态数组 */
  private onSelectCallback: ((selected: ObjectState[]) => void) | null;

  /**
   * 创建对象选择器实例
   * @param findObjectOnClick - 鼠标点击事件处理函数，用于查找点击位置的对象
   * @param getStates - 获取所有对象状态的函数
   * @param geometry - 几何信息对象，包含缩放等变换参数
   * @param canvas - SVG画布容器，用于绘制选择框等UI元素
   */
  public constructor(
    findObjectOnClick: (event: MouseEvent) => void,
    getStates: () => ObjectState[],
    geometry: Geometry,
    canvas: SVG.Container
  ) {
    // 初始化对象选择器的各个属性
    this.findObjectOnClick = findObjectOnClick;
    this.getStates = getStates;
    this.geometry = geometry;
    this.canvas = canvas;
    // 初始化选择框为null
    this.selectionRect = null;
    // 初始状态下选择器未启用
    this.isEnabled = false;
    // 初始化已选择对象映射为空
    this.selectedObjects = {};
    // 初始化重置外观函数映射为空
    this.resetAppearance = {};
    // 初始化鼠标按下位置为原点
    this.mouseDownPosition = { x: 0, y: 0 };
    // 初始化选择过滤器为null
    this.selectionFilter = null;
    // 初始化选择完成回调为空函数
    this.onSelectCallback = null;
  }

  /**
   * 根据当前鼠标位置和初始按下位置计算选择框的边界
   * @param event - 鼠标事件对象，包含当前鼠标坐标
   * @returns 选择框的边界坐标，包含左上角(xtl, ytl)和右下角(xbr, ybr)
   */
  private getSelectionBox(event: MouseEvent): {
    xtl: number;
    ytl: number;
    xbr: number;
    ybr: number;
  } {
    // 将屏幕坐标转换为SVG坐标系中的坐标
    const point = translateToSVG(this.canvas.node as any as SVGSVGElement, [
      event.clientX,
      event.clientY,
    ]);
    // 计算并返回选择框的边界坐标
    return {
      // 左上角X坐标：取初始位置和当前位置的最小值
      xtl: Math.min(this.mouseDownPosition.x, point[0]),
      // 左上角Y坐标：取初始位置和当前位置的最小值
      ytl: Math.min(this.mouseDownPosition.y, point[1]),
      // 右下角X坐标：取初始位置和当前位置的最大值
      xbr: Math.max(this.mouseDownPosition.x, point[0]),
      // 右下角Y坐标：取初始位置和当前位置的最大值
      ybr: Math.max(this.mouseDownPosition.y, point[1]),
    };
  }

  /**
   * 根据选择过滤器过滤对象状态，只返回符合条件的对象
   * @param states - 待过滤的对象状态列表
   * @returns 过滤后的对象状态列表，符合选择条件的对象
   */
  private filterObjects(states: ObjectState[]): ObjectState[] {
    // 获取当前已选择对象的数量
    let count = Object.keys(this.selectedObjects).length;
    // 获取最大可选择数量，如果没有设置则使用最大安全整数
    const maxCount = this.selectionFilter!.maxCount || Number.MAX_SAFE_INTEGER;
    // 初始化过滤结果数组
    const filtered = [];
    // 遍历所有对象状态
    for (const state of states) {
      // 解构获取对象类型和形状类型
      const { objectType, shapeType } = state;
      // 获取允许的对象类型列表，如果没有设置则使用当前对象的类型
      const objectTypes = this.selectionFilter!.objectType || [objectType];
      // 获取允许的形状类型列表，如果没有设置则使用当前对象的形状类型
      const shapeTypes = this.selectionFilter!.shapeType || [shapeType];
      // 检查对象类型和形状类型是否符合过滤条件
      if (objectTypes.includes(objectType) && shapeTypes.includes(shapeType)) {
        // 检查是否已达到最大选择数量
        if (count < maxCount) {
          // 将符合条件的对象添加到过滤结果中
          filtered.push(state);
          // 增加计数器
          count++;
        }
      }
    }

    return filtered;
  }

  /**
   * 鼠标按下事件处理函数，记录初始位置并创建选择框
   * @param event - 鼠标按下事件对象，包含按下位置的坐标信息
   */
  private onMouseDown = (event: MouseEvent): void => {
    // 将屏幕坐标转换为SVG坐标系中的坐标
    const point = translateToSVG(this.canvas.node as any as SVGSVGElement, [
      event.clientX,
      event.clientY,
    ]);
    // 记录鼠标按下的初始位置
    this.mouseDownPosition = { x: point[0], y: point[1] };
    // 创建选择矩形框，并添加选择框样式类
    this.selectionRect = this.canvas.rect().addClass("cvat_canvas_selection_box");
    // 设置选择框的边框宽度，根据当前缩放比例调整
    this.selectionRect.attr({
      "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
    });
    // 设置选择框的初始位置和大小
    this.selectionRect.attr({ ...this.mouseDownPosition });
  };

  /**
   * 鼠标释放事件处理函数，完成选择框内的对象选择
   * @param event - 鼠标释放事件对象，包含释放位置的坐标信息
   */
  private onMouseUp = (event: MouseEvent): void => {
    // 检查是否存在选择框
    if (this.selectionRect) {
      // 移除选择框并清空引用
      this.selectionRect.remove();
      this.selectionRect = null;

      // 获取所有对象状态
      const states = this.getStates();
      // 计算选择框的边界
      const box = this.getSelectionBox(event);
      // 获取所有可见的形状元素
      const shapes = (this.canvas.select(".cvat_canvas_shape") as any).members.filter(
        (shape: SVG.Shape): boolean => !shape.hasClass("cvat_canvas_hidden")
      );

      // 初始化新选择的对象状态数组
      let newStates = [];
      // 遍历所有形状
      for (const shape of shapes) {
        // 获取形状的边界框
        const bbox = shape.bbox();
        // 获取形状的客户端ID
        const clientID = shape.attr("clientID");
        // 检查形状是否完全在选择框内且未被选中
        if (
          bbox.x > box.xtl &&
          bbox.y > box.ytl &&
          bbox.x + bbox.width < box.xbr &&
          bbox.y + bbox.height < box.ybr &&
          !(clientID in this.selectedObjects)
        ) {
          // 根据客户端ID查找对应的对象状态
          const objectState = states.find(
            (state: ObjectState): boolean => state.clientID === clientID
          );
          if (objectState) {
            // 将找到的对象状态添加到新选择列表中
            newStates.push(objectState);
          }
        }
      }

      // 根据选择过滤器过滤新选择的对象
      newStates = this.filterObjects(newStates);
      // 如果有新选择的对象
      if (newStates.length) {
        // 将新选择的对象添加到已选择对象映射中
        newStates.forEach((_state) => {
          this.selectedObjects[_state.clientID] = _state;
        });
        // 调用选择完成回调函数，传递所有已选择的对象
        this.onSelectCallback!(Object.values(this.selectedObjects));
      }
    }
  };

  /**
   * 鼠标移动事件处理函数，实时更新选择框的大小和位置
   * @param event - 鼠标移动事件对象，包含当前位置的坐标信息
   */
  private onMouseMove = (event: MouseEvent): void => {
    // 检查是否存在选择框
    if (this.selectionRect) {
      // 计算当前鼠标位置和初始位置形成的选择框边界
      const box = this.getSelectionBox(event);
      // 更新选择框的位置和大小属性
      this.selectionRect.attr({
        // 设置选择框左上角X坐标
        x: box.xtl,
        // 设置选择框左上角Y坐标
        y: box.ytl,
        // 设置选择框宽度
        width: box.xbr - box.xtl,
        // 设置选择框高度
        height: box.ybr - box.ytl,
      });
    }
  };

  /**
   * 启用对象选择器，设置事件监听器和选择回调
   * @param callback - 选择完成时的回调函数，接收已选择的对象状态数组
   * @param filter - 可选的选择过滤器，用于限制可选择的对象类型和数量
   */
  public enable(
    callback: (selected: ObjectState[]) => void,
    filter?: SelectionFilter
  ): void {
    // 检查选择器是否已启用，避免重复初始化
    if (!this.isEnabled) {
      // 添加鼠标事件监听器到文档和画布
      window.document.addEventListener("mouseup", this.onMouseUp);
      this.canvas.node.addEventListener("mousedown", this.onMouseDown);
      this.canvas.node.addEventListener("mousemove", this.onMouseMove);
      this.canvas.node.addEventListener("click", this.findObjectOnClick);

      // 初始化已选择对象映射为空
      this.selectedObjects = {};
      // 设置选择回调函数，处理选择状态变化
      this.onSelectCallback = (_selected: ObjectState[]): void => {
        // 定义将对象添加到选择中的内部函数，返回重置函数
        const appendToSelection = (objectState: ObjectState): (() => void) => {
          // 获取对象的客户端ID
          const { clientID } = objectState;
          // 根据ID查找对应的形状元素
          const shape = this.canvas.select(`#cvat_canvas_shape_${clientID}`).first();
          if (shape) {
            // 为形状添加选择样式类
            shape.addClass("cvat_canvas_shape_selection");
            // 特殊处理掩码类型的对象
            if (objectState.shapeType === "mask") {
              // 获取掩码点数据
              const { points } = objectState;
              // 设置掩码颜色为浅灰色
              const colorRGB = [252, 251, 252];
              // 从点数据中提取边界坐标
              const [left, top, right, bottom] = points.slice(-4);
              // 创建图像位图数据
              const imageBitmap = expandChannels(
                colorRGB[0],
                colorRGB[1],
                colorRGB[2],
                points
              );

              // 获取形状的边界框
              const bbox = shape.bbox();
              // 创建图像元素并设置属性
              const image = this.canvas
                .image()
                .attr({
                  "color-rendering": "optimizeQuality",
                  "shape-rendering": "geometricprecision",
                  "data-z-order": Number.MAX_SAFE_INTEGER,
                  "grouping-copy-for": clientID,
                })
                .move(bbox.x, bbox.y);

              // 将图像位图转换为数据URL并加载到图像元素
              imageDataToDataURL(
                imageBitmap,
                right - left + 1,
                bottom - top + 1,
                (dataURL: string) =>
                  new Promise((resolve, reject) => {
                    image.loaded(() => {
                      resolve();
                    });
                    image.error(() => {
                      reject();
                    });
                    image.load(dataURL);
                  })
              );

              // 设置图像样式以提高可见性
              image.style("filter", "drop-shadow(2px 4px 6px black)"); // for better visibility
              image.attr("opacity", 0.5);
              // 返回清理函数，用于移除图像和选择样式
              return () => {
                image.remove();
                shape.removeClass("cvat_canvas_shape_selection");
              };
            }

            // 对于非掩码对象，返回移除选择样式的函数
            return () => shape.removeClass("cvat_canvas_shape_selection");
          }

          // 如果找不到形状，返回空函数
          return () => {};
        };

        // 遍历新选择的对象，为每个对象添加选择样式
        for (const state of _selected) {
          // 检查对象是否已应用选择样式
          if (!Object.hasOwn(this.resetAppearance, state.clientID)) {
            // 应用选择样式并保存重置函数
            this.resetAppearance[state.clientID] = appendToSelection(state);
          }
        }

        // 遍历已应用样式的对象，移除不再被选择的对象的样式
        for (const clientID of Object.keys(this.resetAppearance)) {
          // 检查对象是否仍在选择列表中
          if (!_selected.some((state) => state.clientID === +clientID)) {
            // 调用重置函数移除样式并删除记录
            this.resetAppearance[Number.parseInt(clientID)]();
            delete this.resetAppearance[Number.parseInt(clientID)];
          }
        }

        // 调用外部回调函数，传递当前选择的对象
        callback(_selected);
      };

      // 设置选择过滤器
      if (filter !== undefined) {
        this.selectionFilter = filter;
      }
      // 标记选择器为已启用状态
      this.isEnabled = true;
    }
  }

  /**
   * 禁用对象选择器功能
   * 移除所有事件监听器，清理选择状态，重置选择器到初始状态
   */
  public disable(): void {
    // 移除全局鼠标事件监听器
    window.document.removeEventListener("mouseup", this.onMouseUp);
    // 移除画布上的鼠标事件监听器
    this.canvas.node.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.node.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.node.removeEventListener("click", this.findObjectOnClick);

    // 如果存在选择框，则移除它
    if (this.selectionRect) {
      this.selectionRect.remove();
      this.selectionRect = null;
    }

    // 重置所有已选择对象的外观
    for (const clientID of Object.keys(this.resetAppearance)) {
      this.resetAppearance[Number.parseInt(clientID)]();
    }

    // 清理选择器状态
    this.onSelectCallback = null;
    this.resetAppearance = {};
    this.isEnabled = false;
  }

  /**
   * 添加或移除对象到选择列表
   * 如果对象未被选择，则尝试添加；如果已被选择，则移除
   * @param state 要添加或移除的对象状态
   */
  public push(state: ObjectState): void {
    // 检查选择器是否已启用
    if (this.isEnabled) {
      // 检查对象是否已被选择
      if (!Object.hasOwn(this.selectedObjects, state.clientID)) {
        // 过滤对象，检查是否符合选择条件
        const filtered = this.filterObjects([state]);
        if (filtered.length) {
          // 添加过滤后的对象到选择列表
          filtered.forEach((_state) => {
            this.selectedObjects[_state.clientID] = _state;
          });
          // 调用选择回调，更新选择状态
          this.onSelectCallback!(Object.values(this.selectedObjects));
        }
      } else {
        // 如果对象已被选择，则从选择列表中移除
        delete this.selectedObjects[state.clientID];
        // 调用选择回调，更新选择状态
        this.onSelectCallback!(Object.values(this.selectedObjects));
      }
    }
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

  /**
   * 重置所有已选择对象的状态
   * 清除选择状态，恢复对象原始外观，并调用回调函数通知选择已清空
   */
  public resetSelected(): void {
    // 检查选择器是否已启用
    if (this.isEnabled) {
      // 重置所有已选择对象的外观
      for (const clientID of Object.keys(this.resetAppearance)) {
        this.resetAppearance[Number.parseInt(clientID)]();
      }
      // 清空选择对象映射
      this.selectedObjects = {};
      // 清空外观重置函数映射
      this.resetAppearance = {};

      // 如果存在选择回调，则调用它并传入空数组
      if (this.onSelectCallback) {
        this.onSelectCallback([]);
      }
    }
  }
}
