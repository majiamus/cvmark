// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type * as SVG from "svg.js";

import Crosshair from "../componets/crosshair";
import consts from "../consts/consts";
import type {
  Configuration,
  Geometry,
  InteractionData,
  InteractionResult,
} from "../core/canvasModel";
import {
  expandChannels,
  imageDataToDataURL,
  type PropType,
  stringifyPoints,
  translateToCanvas,
  translateToSVG,
} from "../utils/shared";

/**
 * 交互处理器接口，定义形状交互操作的基本方法
 * 用于管理用户与画布上形状的交互，包括绘制、变换和配置
 */
export interface InteractionHandler {
  /**
   * 变换几何信息
   * @param geometry - 包含偏移量、缩放比例和图像尺寸的几何信息
   */
  transform(geometry: Geometry): void;

  /**
   * 执行交互操作
   * @param interactData - 包含交互类型、启用状态和配置的交互数据
   */
  interact(interactData: InteractionData): void;

  /**
   * 配置交互参数
   * @param config - 包含控制点大小和选中形状透明度的配置对象
   */
  configure(config: Configuration): void;

  /**
   * 销毁交互处理器，释放资源
   */
  destroy(): void;

  /**
   * 取消当前交互操作
   */
  cancel(): void;
}

/**
 * 交互处理器实现类
 * 负责处理画布上的各种交互操作，包括形状创建、编辑、变换等
 * 实现了InteractionHandler接口，提供完整的交互功能
 */
export class InteractionHandlerImpl implements InteractionHandler {
  /** 交互完成回调函数，当形状交互完成时调用 */
  private onInteraction: (
    shapes: InteractionResult[] | null,
    shapesUpdated?: boolean,
    isDone?: boolean
  ) => void;
  /** 几何信息，包含偏移量、缩放比例和图像尺寸 */
  private geometry: Geometry;
  /** SVG画布容器，用于绘制和操作形状 */
  private canvas: SVG.Container;
  /** 交互数据，包含交互类型、启用状态和配置信息 */
  private interactionData: InteractionData;
  /** 当前鼠标光标位置坐标 */
  private cursorPosition: { x: number; y: number };
  /** 形状是否已更新的标记 */
  private shapesWereUpdated: boolean;
  /** 交互过程中创建的形状数组 */
  private interactionShapes: SVG.Shape[];
  /** 当前正在交互的形状，可能为null */
  private currentInteractionShape: SVG.Shape | null;
  /** 十字准线组件，用于精确定位 */
  private crosshair: Crosshair;
  /** 中间形状数据，用于显示临时形状 */
  private intermediateShape: PropType<InteractionData, "intermediateShape">;
  /** 已绘制的中间形状SVG对象 */
  private drawnIntermediateShape: SVG.Shape | null;
  /** 控制点大小，用于绘制交互点 */
  private controlPointsSize: number;
  /** 选中形状的透明度 */
  private selectedShapeOpacity: number;
  /** 交互是否已取消的标记 */
  private cancelled: boolean;

  /**
   * 准备交互结果数据
   * 将交互形状转换为InteractionResult格式
   * @returns 交互结果数组，包含点形状和矩形形状的数据
   */
  private prepareResult(): InteractionResult[] {
    return this.interactionShapes.map((shape: SVG.Shape): InteractionResult => {
      // 处理圆形（点）形状
      if (shape.type === "circle") {
        // 获取圆心坐标
        const points = [(shape as SVG.Circle).cx(), (shape as SVG.Circle).cy()];
        return {
          // 将坐标转换为相对于图像偏移的坐标
          points: points.map((coord: number): number => coord - this.geometry.offset),
          shapeType: "points",
          // 根据描边颜色确定按钮类型：绿色为左键(0)，其他为右键(2)
          button: shape.attr("stroke") === "green" ? 0 : 2,
        };
      }

      // 处理矩形形状
      // 获取矩形的边界框
      const bbox = (shape.node as any as SVGRectElement).getBBox();
      // 计算矩形的左上角和右下角坐标
      const points = [bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height];
      return {
        // 将坐标转换为相对于图像偏移的坐标
        points: points.map((coord: number): number => coord - this.geometry.offset),
        shapeType: "rectangle",
        button: 0,
      };
    });
  }

  /**
   * 判断是否应该触发交互事件
   * 根据交互数据、形状数量和更新状态决定是否触发事件
   * @returns 如果应该触发事件返回true，否则返回false
   */
  private shouldRaiseEvent(): boolean {
    // 解构获取交互相关数据
    const { interactionData, interactionShapes, shapesWereUpdated } = this;
    const { minPosVertices, minNegVertices, enabled } = interactionData;

    // 筛选出正样本形状（绿色描边）
    const positiveShapes = interactionShapes.filter(
      (shape: SVG.Shape): boolean => (shape as any).attr("stroke") === "green"
    );
    // 筛选出负样本形状（非绿色描边）
    const negativeShapes = interactionShapes.filter(
      (shape: SVG.Shape): boolean => (shape as any).attr("stroke") !== "green"
    );

    // 检查是否有形状被绘制（矩形或正样本点）
    const somethingWasDrawn =
      interactionShapes.some((shape) => shape.type === "rect") || !!positiveShapes.length;
    // 如果是矩形交互，只要有形状且启用就触发事件
    if (interactionData.shapeType === "rectangle") {
      return enabled && !!interactionShapes.length;
    }

    // 检查最小正样本顶点数是否已定义
    const minPosVerticesDefined = Number.isInteger(minPosVertices);
    // 检查最小负样本顶点数是否已定义且非负
    const minNegVerticesDefined =
      Number.isInteger(minNegVertices) && minNegVertices! >= 0;
    // 检查是否达到最小正样本顶点数要求
    const minPosVerticesAchieved =
      !minPosVerticesDefined || minPosVertices! <= positiveShapes.length;
    // 检查是否达到最小负样本顶点数要求
    const minNegVerticesAchieved =
      !minNegVerticesDefined || minNegVertices! <= negativeShapes.length;
    // 检查是否达到所有最小顶点数要求
    const minimumVerticesAchieved = minPosVerticesAchieved && minNegVerticesAchieved;
    // 综合判断：启用状态、有形状绘制、达到最小顶点数要求且形状已更新
    return enabled && somethingWasDrawn && minimumVerticesAchieved && shapesWereUpdated;
  }

  /**
   * 添加十字准线到画布
   * 在当前光标位置显示十字准线
   */
  private addCrosshair(): void {
    // 获取当前光标位置
    const { x, y } = this.cursorPosition;
    // 在指定位置显示十字准线，考虑当前缩放比例
    this.crosshair.show(this.canvas, x, y, this.geometry.scale);
  }

  /**
   * 移除十字准线
   * 隐藏当前显示的十字准线
   */
  private removeCrosshair(): void {
    // 隐藏十字准线
    this.crosshair.hide();
  }

  /**
   * 处理点形状的交互
   * 监听鼠标事件，在点击位置创建可交互的点形状
   */
  private interactPoints(): void {
    // 定义鼠标事件监听器
    const eventListener = (e: MouseEvent): void => {
      // 只处理左键点击或右键点击（当允许负样本时），且未按住Alt键
      if (
        (e.button === 0 ||
          (e.button === 2 && this.interactionData.minNegVertices! >= 0)) &&
        !e.altKey
      ) {
        // 阻止默认行为
        e.preventDefault();
        // 将客户端坐标转换为SVG坐标
        const [cx, cy] = translateToSVG(this.canvas.node as any as SVGSVGElement, [
          e.clientX,
          e.clientY,
        ]);
        // 检查点是否在图像框架内
        if (!this.isWithinFrame(cx, cy)) return;

        // 创建当前交互点形状
        this.currentInteractionShape = this.canvas
          .circle((this.controlPointsSize * 2) / this.geometry.scale) // 圆的直径是控制点大小的两倍，考虑缩放
          .center(cx, cy) // 设置圆心位置
          .fill("white") // 填充白色
          .stroke(e.button === 0 ? "green" : "red") // 根据鼠标按钮设置描边颜色：左键绿色，右键红色
          .addClass("cvat_interaction_point") // 添加CSS类
          .attr({
            "stroke-width": consts.POINTS_STROKE_WIDTH / this.geometry.scale, // 设置描边宽度，考虑缩放
          });

        // 将新创建的形状添加到交互形状数组
        this.interactionShapes.push(this.currentInteractionShape);
        // 标记形状已更新
        this.shapesWereUpdated = true;
        // 如果满足触发条件，触发交互事件
        if (this.shouldRaiseEvent()) {
          this.onInteraction(this.prepareResult(), true, false);
        }

        // 保存当前形状的引用
        const self = this.currentInteractionShape;
        // 鼠标进入形状时的处理
        self.on("mouseenter", (): void => {
          // 如果只允许删除最后一个点，且当前不是最后一个点，则不处理
          if (this.interactionData.allowRemoveOnlyLast) {
            if (
              this.interactionShapes.indexOf(self) !==
              this.interactionShapes.length - 1
            ) {
              return;
            }
          }

          // 添加可删除样式类
          self.addClass("cvat_canvas_removable_interaction_point");
          // 更新形状属性，增大描边宽度和半径
          self.attr({
            "stroke-width": consts.POINTS_SELECTED_STROKE_WIDTH / this.geometry.scale,
            r: (this.controlPointsSize * 1.5) / this.geometry.scale,
          });

          // 鼠标按下时的处理
          self.on("mousedown", (_e: MouseEvent): void => {
            _e.preventDefault();
            _e.stopPropagation();
            // 移除当前形状
            self.remove();
            // 标记形状已更新
            this.shapesWereUpdated = true;
            // 从交互形状数组中移除当前形状
            this.interactionShapes = this.interactionShapes.filter(
              (shape: SVG.Shape): boolean => shape !== self
            );
            // 如果是先绘制矩形框模式且只剩一个形状（矩形框），则显示该矩形框
            if (
              this.interactionData.startWithBox &&
              this.interactionShapes.length === 1
            ) {
              this.interactionShapes[0].style({ visibility: "" });
            }
            // 检查是否应该触发事件
            const shouldRaiseEvent = this.shouldRaiseEvent();
            if (shouldRaiseEvent) {
              this.onInteraction(this.prepareResult(), true, false);
            }
          });
        });

        // 鼠标离开形状时的处理
        self.on("mouseleave", (): void => {
          // 移除可删除样式类
          self.removeClass("cvat_canvas_removable_interaction_point");
          // 恢复原始形状属性
          self.attr({
            "stroke-width": consts.POINTS_STROKE_WIDTH / this.geometry.scale,
            r: this.controlPointsSize / this.geometry.scale,
          });

          // 移除鼠标按下事件监听器
          self.off("mousedown");
        });
      }
    };

    // 在画布上添加鼠标按下事件监听器，在release()方法中清除
    this.canvas.on("mousedown.interaction", eventListener);
  }

  /**
   * 处理矩形形状的交互
   * @param shouldFinish 是否在绘制完成后结束交互
   * @param onContinue 可选的回调函数，在绘制完成后继续执行其他交互
   */
  private interactRectangle(shouldFinish: boolean, onContinue?: () => void): void {
    // 初始化标记，用于判断是否是第一次点击
    let initialized = false;
    // 鼠标事件监听器，处理矩形绘制
    const eventListener = (e: MouseEvent): void => {
      // 只处理左键点击且未按下Alt键的情况
      if (e.button === 0 && !e.altKey) {
        if (!initialized) {
          // 第一次点击时启用网格吸附并开始绘制
          (this.currentInteractionShape as any).draw(e, { snapToGrid: 0.1 });
          initialized = true;
        } else {
          // 后续点击继续绘制
          (this.currentInteractionShape as any).draw(e);
        }
      }
    };

    // 创建矩形形状
    this.currentInteractionShape = this.canvas.rect();
    // 绑定鼠标按下事件监听器
    this.canvas.on("mousedown.interaction", eventListener);
    // 配置矩形形状的事件和样式
    this.currentInteractionShape
      .on("drawstop", (): void => {
        // 如果交互已被取消，直接返回
        if (this.cancelled) {
          return;
        }

        // 移除鼠标事件监听器
        this.canvas.off("mousedown.interaction", eventListener);
        // 将当前形状添加到交互形状数组
        this.interactionShapes.push(this.currentInteractionShape!);
        // 标记形状已更新
        this.shapesWereUpdated = true;

        // 根据参数决定是否结束交互
        if (shouldFinish) {
          this.interact({ enabled: false });
        } else if (this.shouldRaiseEvent()) {
          // 触发交互事件，传递准备好的结果数据
          this.onInteraction(this.prepareResult(), true, false);
        }

        // 如果有继续回调，执行它
        if (onContinue) {
          onContinue();
        }
      })
      // 添加绘制样式类
      .addClass("cvat_canvas_shape_drawing")
      // 设置形状属性
      .attr({
        // 根据缩放比例计算线宽
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
      })
      // 设置填充样式
      .fill({ opacity: this.selectedShapeOpacity, color: "white" });
  }

  /**
   * 初始化交互环境
   * 根据交互数据配置是否显示十字准线
   */
  private initInteraction(): void {
    // 如果交互数据要求显示十字准线，则添加它
    if (this.interactionData.crosshair) {
      this.addCrosshair();
    } else if (this.crosshair) {
      // 否则如果当前有十字准线，则移除它
      this.removeCrosshair();
    }
  }

  /**
   * 开始交互操作
   * 根据交互数据中的形状类型启动相应的交互方法
   */
  private startInteraction(): void {
    // 根据形状类型选择交互方式
    if (this.interactionData.shapeType === "rectangle") {
      // 矩形交互，完成后结束
      this.interactRectangle(true);
    } else if (this.interactionData.shapeType === "points") {
      // 点形状交互
      if (this.interactionData.startWithBox) {
        // 如果需要先绘制矩形，则先绘制矩形再进行点交互
        this.interactRectangle(false, (): void => this.interactPoints());
      } else {
        // 直接进行点交互
        this.interactPoints();
      }
    } else {
      // 不支持的形状类型，抛出错误
      throw new Error("Interactor implementation supports only rectangle and points");
    }
  }

  /**
   * 释放交互资源
   * 清理所有交互相关的形状、事件监听器和状态
   */
  private release(): void {
    // 如果当前有正在绘制的形状，取消绘制
    if (
      this.currentInteractionShape &&
      this.currentInteractionShape.remember("_paintHandler")
    ) {
      // 取消活动绘制
      (this.currentInteractionShape as any).draw("cancel");
    }

    // 如果有已绘制的中间形状，移除它
    if (this.drawnIntermediateShape) {
      this.drawnIntermediateShape.remove();
      this.drawnIntermediateShape = null;
    }

    // 如果有十字准线，移除它
    if (this.crosshair) {
      this.removeCrosshair();
    }

    // 移除鼠标事件监听器
    this.canvas.off("mousedown.interaction");
    // 移除所有交互形状
    this.interactionShapes.forEach((shape: SVG.Shape): SVG.Shape => shape.remove());
    // 清空交互形状数组
    this.interactionShapes = [];
    // 如果有当前交互形状，移除它并清空引用
    if (this.currentInteractionShape) {
      this.currentInteractionShape.remove();
      this.currentInteractionShape = null;
    }
  }

  /**
   * 检查坐标是否在图像帧范围内
   * @param x X坐标
   * @param y Y坐标
   * @returns 是否在图像帧范围内
   */
  private isWithinFrame(x: number, y: number): boolean {
    // 从几何信息中获取偏移量和图像尺寸
    const { offset, image } = this.geometry;
    const { width, height } = image;
    // 计算相对于图像的坐标
    const [imageX, imageY] = [Math.round(x - offset), Math.round(y - offset)];
    // 检查坐标是否在图像范围内
    return imageX >= 0 && imageX < width && imageY >= 0 && imageY < height;
  }

  /**
   * 更新中间形状的显示
   * 根据中间形状数据创建或更新画布上的形状显示
   */
  private updateIntermediateShape(): void {
    // 获取中间形状和几何信息
    const { intermediateShape, geometry } = this;
    // 如果没有中间形状，移除已绘制的中间形状并返回
    if (!intermediateShape) {
      if (this.drawnIntermediateShape) {
        this.drawnIntermediateShape.remove();
      }

      return;
    }

    // 获取形状类型和点数据
    const { shapeType, points } = intermediateShape;
    // 如果已绘制的形状是多边形且新形状也是多边形，更新现有形状
    if (this.drawnIntermediateShape?.type === "polygon" && shapeType === "polygon") {
      // 检查形状是否无效（点数少于3个顶点）
      const isInvalidShape = shapeType === "polygon" && points.length < 3 * 2;
      // 更新多边形的点
      this.drawnIntermediateShape.attr(
        "points",
        stringifyPoints(translateToCanvas(geometry.offset, points))
      );
      // 根据形状有效性设置描边颜色
      this.drawnIntermediateShape.stroke(isInvalidShape ? "red" : "black");
      return;
    }

    // 移除已绘制的中间形状
    this.drawnIntermediateShape?.remove();
    // 根据形状类型创建新的形状
    if (shapeType === "polygon") {
      // 检查形状是否无效（点数少于3个顶点）
      const isInvalidShape = shapeType === "polygon" && points.length < 3 * 2;
      // 创建多边形形状
      this.drawnIntermediateShape = this.canvas
        .polygon(stringifyPoints(translateToCanvas(geometry.offset, points)))
        .attr({
          "color-rendering": "optimizeQuality",
          "shape-rendering": "geometricprecision",
          // 根据缩放比例设置线宽
          "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
          // 根据形状有效性设置描边颜色
          stroke: isInvalidShape ? "red" : "black",
        })
        // 设置填充样式
        .fill({ opacity: this.selectedShapeOpacity, color: "white" })
        // 添加样式类
        .addClass("cvat_canvas_interact_intermediate_shape");
      // 将形状添加到画布前面
      this.canvas.node.prepend(this.drawnIntermediateShape.node);
    } else if (shapeType === "mask") {
      // 获取掩码边界
      const [left, top, right, bottom] = points.slice(-4);
      // 创建图像位图
      const imageBitmap = expandChannels(255, 255, 255, points);

      // 创建图像元素
      const image = this.canvas
        .image()
        .attr({
          "color-rendering": "optimizeQuality",
          "shape-rendering": "geometricprecision",
          // 禁用鼠标事件
          "pointer-events": "none",
          // 设置透明度
          opacity: 0.5,
        })
        .addClass("cvat_canvas_interact_intermediate_shape");
      // 设置图像位置
      image.move(this.geometry.offset + left, this.geometry.offset + top);
      this.drawnIntermediateShape = image;
      // 将图像添加到画布前面
      this.canvas.node.prepend(this.drawnIntermediateShape.node);

      // 将图像位图转换为数据URL并加载
      imageDataToDataURL(
        imageBitmap,
        right - left + 1,
        bottom - top + 1,
        (dataURL: string) =>
          new Promise((resolve, reject) => {
            // 图像加载完成时解析Promise
            image.loaded(() => {
              resolve();
            });
            // 图像加载错误时拒绝Promise
            image.error(() => {
              reject();
            });
            // 加载图像
            image.load(dataURL);
          })
      );
    } else {
      // 不支持的形状类型，抛出错误
      throw new Error(
        `Shape type "${shapeType}" was not implemented at interactionHandler::updateIntermediateShape`
      );
    }
  }

  /**
   * 检查视觉组件是否发生变化
   * @param interactionData 新的交互数据
   * @returns 是否需要更新视觉组件
   */
  private visualComponentsChanged(interactionData: InteractionData): boolean {
    // 允许的键列表，只检查这些键的变化
    const allowedKeys = ["enabled", "crosshair"];
    // 如果交互数据只包含允许的键
    if (
      Object.keys(interactionData).every((key: string): boolean =>
        allowedKeys.includes(key)
      )
    ) {
      // 检查十字准线状态是否发生变化
      if (
        this.interactionData.crosshair !== undefined &&
        interactionData.crosshair !== undefined &&
        this.interactionData.crosshair !== interactionData.crosshair
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 构造函数，初始化交互处理器
   * @param onInteraction 交互完成回调函数
   * @param canvas SVG画布容器
   * @param geometry 几何信息
   * @param configuration 配置信息
   */
  public constructor(
    onInteraction: (
      shapes: InteractionResult[] | null,
      shapesUpdated?: boolean,
      isDone?: boolean
    ) => void,
    canvas: SVG.Container,
    geometry: Geometry,
    configuration: Configuration
  ) {
    // 包装交互回调函数，在调用前重置形状更新标记
    this.onInteraction = (
      shapes: InteractionResult[] | null,
      shapesUpdated?: boolean,
      isDone?: boolean
    ): void => {
      this.shapesWereUpdated = false;
      onInteraction(shapes, shapesUpdated, isDone);
    };
    // 初始化基本属性
    this.canvas = canvas;
    this.geometry = geometry;
    this.shapesWereUpdated = false;
    this.interactionShapes = [];
    this.interactionData = { enabled: false };
    this.currentInteractionShape = null;
    this.cancelled = false;
    // 创建十字准线组件
    this.crosshair = new Crosshair();
    this.intermediateShape = undefined;
    this.drawnIntermediateShape = null;
    // 从配置中获取控制点大小和选中形状透明度
    this.controlPointsSize = configuration.controlPointsSize!;
    this.selectedShapeOpacity = configuration.selectedShapeOpacity!;
    // 初始化光标位置
    this.cursorPosition = {
      x: 0,
      y: 0,
    };

    // 添加鼠标移动事件监听器
    this.canvas.on("mousemove.interaction", (e: MouseEvent): void => {
      // 将客户端坐标转换为SVG坐标
      const [x, y] = translateToSVG(this.canvas.node as any as SVGSVGElement, [
        e.clientX,
        e.clientY,
      ]);
      // 更新光标位置
      this.cursorPosition = { x, y };
      // 更新十字准线位置
      if (this.crosshair) {
        this.crosshair.move(x, y);
      }

      // 如果启用滑动且有交互形状
      if (this.interactionData.enableSliding && this.interactionShapes.length) {
        // 检查坐标是否在图像帧内
        if (this.isWithinFrame(x, y)) {
          // 触发交互事件，传递当前结果和新的点
          this.onInteraction(
            [
              ...this.prepareResult(),
              {
                // 计算相对于图像的坐标
                points: [x - this.geometry.offset, y - this.geometry.offset],
                shapeType: "points",
                button: 0,
              },
            ],
            true,
            false
          );
        }
      }
    });
  }

  /**
   * 变换几何信息
   * 根据新的几何信息更新所有形状的缩放比例和位置
   * @param geometry 新的几何信息
   */
  public transform(geometry: Geometry): void {
    // 更新几何信息
    this.geometry = geometry;

    // 更新十字准线的缩放比例
    if (this.crosshair) {
      this.crosshair.scale(this.geometry.scale);
    }

    // 确定需要缩放的形状（包括当前交互形状）
    const shapesToBeScaled = this.currentInteractionShape
      ? [...this.interactionShapes, this.currentInteractionShape]
      : [...this.interactionShapes];

    // 遍历所有形状并更新缩放
    for (const shape of shapesToBeScaled) {
      if (shape.type === "circle") {
        // 处理圆形形状（通常是控制点）
        if (shape.hasClass("cvat_canvas_removable_interaction_point")) {
          // 可移除的交互点（选中的点）使用更大的半径和线宽
          (shape as SVG.Circle).radius(
            (this.controlPointsSize * 1.5) / this.geometry.scale
          );
          shape.attr(
            "stroke-width",
            consts.POINTS_SELECTED_STROKE_WIDTH / this.geometry.scale
          );
        } else {
          // 普通点使用标准半径和线宽
          (shape as SVG.Circle).radius(this.controlPointsSize / this.geometry.scale);
          shape.attr("stroke-width", consts.POINTS_STROKE_WIDTH / this.geometry.scale);
        }
      } else {
        // 其他形状类型只更新线宽
        shape.attr("stroke-width", consts.BASE_STROKE_WIDTH / this.geometry.scale);
      }
    }

    // 更新中间形状的线宽
    if (this.drawnIntermediateShape) {
      this.drawnIntermediateShape.stroke({
        width: consts.BASE_STROKE_WIDTH / this.geometry.scale,
      });
    }
  }

  /**
   * 执行交互操作
   * 根据交互数据启用、禁用或配置交互功能
   * @param interactionData 交互数据，包含交互类型、状态和配置信息
   */
  public interact(interactionData: InteractionData): void {
    // 如果启用了交互
    if (interactionData.enabled) {
      // 重置取消标记
      this.cancelled = false;
      // 如果有中间形状数据
      if (interactionData.intermediateShape) {
        // 设置中间形状并更新显示
        this.intermediateShape = interactionData.intermediateShape;
        this.updateIntermediateShape();
        // 如果需要先绘制矩形，隐藏第一个交互形状
        if (this.interactionData.startWithBox) {
          this.interactionShapes[0].style({ visibility: "hidden" });
        }
      } else if (this.visualComponentsChanged(interactionData)) {
        // 如果视觉组件发生变化，更新交互数据并初始化交互
        this.interactionData = { ...this.interactionData, ...interactionData };
        this.initInteraction();
      } else if (interactionData.enabled) {
        // 否则如果启用了交互，更新交互数据并开始交互
        this.interactionData = interactionData;
        this.initInteraction();
        this.startInteraction();
      }
    } else {
      // 如果禁用了交互
      // 如果当前有正在绘制的形状，尝试完成绘制
      if (
        this.currentInteractionShape &&
        this.currentInteractionShape.remember("_paintHandler")
      ) {
        // 尝试完成活动绘制
        (this.currentInteractionShape as any).draw("stop");
      }

      // 触发交互完成事件，传递结果和状态
      this.onInteraction(this.prepareResult(), this.shouldRaiseEvent(), true);
      // 释放交互资源
      this.release();
      // 更新交互数据
      this.interactionData = interactionData;
    }
  }

  /**
   * 配置交互处理器的参数
   * @param configuration - 包含控制点大小和选中形状不透明度等配置信息
   */
  public configure(configuration: Configuration): void {
    // 更新控制点大小配置
    this.controlPointsSize = configuration.controlPointsSize!;
    // 更新选中形状的不透明度配置
    this.selectedShapeOpacity = configuration.selectedShapeOpacity!;

    // 更新中间绘制形状的不透明度
    if (this.drawnIntermediateShape) {
      this.drawnIntermediateShape.fill({
        opacity: configuration.selectedShapeOpacity,
      });
    }

    // 当使用interactRectangle方法时，更新当前交互矩形的不透明度
    if (this.currentInteractionShape && this.currentInteractionShape.type === "rect") {
      this.currentInteractionShape.fill({ opacity: configuration.selectedShapeOpacity });
    }

    // 当使用interactPoints方法且以边界框开始时，更新第一个交互矩形的不透明度
    if (this.interactionShapes[0] && this.interactionShapes[0].type === "rect") {
      this.interactionShapes[0].fill({ opacity: configuration.selectedShapeOpacity });
    }
  }

  /**
   * 取消当前交互操作
   * 设置取消标志，释放资源并触发交互结束事件
   */
  public cancel(): void {
    // 设置取消标志为true
    this.cancelled = true;
    // 释放交互资源
    this.release();
    // 触发交互结束事件，传入null表示取消
    this.onInteraction(null);
  }

  /**
   * 销毁交互处理器
   * 清理资源，当前实现中无需额外操作
   */
  public destroy(): void {
    // 当前实现中无需释放额外资源
  }
}
