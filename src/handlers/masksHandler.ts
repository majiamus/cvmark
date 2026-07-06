// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { fabric } from "fabric";
import debounce from "lodash/debounce";

import consts from "../consts/consts";
import {
  type BrushTool,
  ColorBy,
  type Configuration,
  type DrawData,
  type Geometry,
  type MasksEditData,
  type Position,
} from "../core/canvasModel";
import {
  computeWrappingBox,
  expandChannels,
  imageDataToDataURL,
  type PropType,
  zipChannels,
} from "../utils/shared";

import type { DrawHandler } from "./drawHandler";

/**
 * 包围盒接口，用于定义矩形区域的边界
 * 包含左上角和右下角的坐标信息
 */
interface WrappingBBox {
  /** 左边界坐标 */
  left: number;
  /** 上边界坐标 */
  top: number;
  /** 右边界坐标 */
  right: number;
  /** 下边界坐标 */
  bottom: number;
}

/**
 * 掩码处理器接口，定义了掩码绘制和编辑的基本操作
 * 提供掩码的绘制、编辑、配置、变换和取消功能
 */
export interface MasksHandler {
  /**
   * 绘制掩码
   * @param drawData - 包含绘制所需数据的对象
   */
  draw(drawData: DrawData): void;

  /**
   * 编辑掩码状态
   * @param state - 包含掩码编辑状态信息的对象
   */
  edit(state: MasksEditData): void;

  /**
   * 配置掩码处理器参数
   * @param configuration - 包含配置信息的对象
   */
  configure(configuration: Configuration): void;

  /**
   * 变换掩码几何信息
   * @param geometry - 包含几何变换信息的对象
   */
  transform(geometry: Geometry): void;

  /**
   * 取消当前操作
   */
  cancel(): void;

  /** 掩码处理器是否启用 */
  enabled: boolean;
}

export class MasksHandlerImpl implements MasksHandler {
  /** 绘制完成回调函数，当绘制操作完成时调用 */
  private onDrawDone: (
    data: object | null,
    duration?: number,
    continueDraw?: boolean,
    prevDrawData?: DrawData
  ) => void;
  /** 重复绘制回调函数，当需要重复绘制时调用 */
  private onDrawRepeat: (data: DrawData) => void;
  /** 编辑开始回调函数，当开始编辑时调用 */
  private onEditStart: (state: any) => void;
  /** 编辑完成回调函数，当编辑完成时调用 */
  private onEditDone: (state: any, points: number[]) => void;
  /** 矢量绘制处理器，用于处理矢量图形的绘制 */
  private vectorDrawHandler: DrawHandler;

  /** 重绘计时器ID，用于控制重绘操作 */
  private redraw: number | null;
  /** 是否正在绘制的标志 */
  private isDrawing: boolean;
  /** 是否正在编辑的标志 */
  private isEditing: boolean;
  /** 是否处于插入模式的标志 */
  private isInsertion: boolean;
  /** 鼠标是否按下的标志 */
  private isMouseDown: boolean;
  /** 是否正在调整画笔大小的标志 */
  private isBrushSizeChanging: boolean;
  /** 调整画笔工具时的最新X坐标 */
  private resizeBrushToolLatestX: number;
  /** 画笔标记，用于显示当前画笔位置和大小 */
  private brushMarker: fabric.Rect | fabric.Circle | null;
  /** 可绘制多边形对象，用于多边形绘制模式 */
  private drawablePolygon: null | fabric.Polygon;
  /** 是否正在绘制多边形的标志 */
  private isPolygonDrawing: boolean;
  /** 已绘制对象数组，存储所有已绘制的图形对象 */
  private drawnObjects: (
    | fabric.Polygon
    | fabric.Circle
    | fabric.Rect
    | fabric.Line
    | fabric.Image
  )[];

  /** 当前使用的绘制工具类型 */
  private tool: DrawData["brushTool"] | null;
  /** 绘制数据，包含绘制所需的所有信息 */
  private drawData: DrawData | null;
  /** Fabric画布实例，用于绘制操作 */
  private canvas: fabric.Canvas;

  /** 编辑数据，包含编辑所需的所有信息 */
  private editData: MasksEditData | null;

  /** 颜色分配方式，决定如何为不同区域分配颜色 */
  private colorBy: ColorBy;
  /** 最新鼠标位置，记录鼠标的当前位置 */
  private latestMousePos: Position;
  /** 开始时间戳，记录操作开始的时间 */
  private startTimestamp: number;
  /** 几何信息，包含画布的几何变换信息 */
  private geometry: Geometry | null;
  /** 绘制不透明度，控制绘制图形的透明度 */
  private drawingOpacity: number;
  /** 是否隐藏的标志，控制掩码的显示/隐藏状态 */
  private isHidden: boolean;

  /**
   * 保留已绘制的多边形
   * 重置画布包装器的CSS样式，结束多边形绘制模式，并禁用矢量绘制处理器
   */
  private keepDrawnPolygon(): void {
    // 获取画布包装器元素
    const canvasWrapper = this.canvas.getElement().parentElement;
    // 重置指针事件样式
    canvasWrapper!.style.pointerEvents = "";
    // 重置z-index样式
    canvasWrapper!.style.zIndex = "";
    // 结束多边形绘制模式
    this.isPolygonDrawing = false;
    // 禁用矢量绘制处理器
    this.vectorDrawHandler.draw({ enabled: false }, this.geometry!);
  }

  /**
   * 移除画笔标记
   * 从画布中移除画笔标记对象并重置相关状态
   */
  private removeBrushMarker(): void {
    // 检查画笔标记是否存在
    if (this.brushMarker) {
      // 从画布中移除画笔标记
      this.canvas.remove(this.brushMarker);
      // 重置画笔标记引用
      this.brushMarker = null;
      // 重新渲染画布
      this.canvas.renderAll();
    }
  }

  /**
   * 设置画笔标记
   * 根据当前工具类型和形状创建并添加画笔标记到画布
   */
  private setupBrushMarker(): void {
    // 检查工具类型是否为画笔或橡皮擦
    if (["brush", "eraser"].includes(this.tool!.type)) {
      // 定义画笔标记的通用属性
      const common = {
        evented: false,
        selectable: false,
        opacity: 0.75,
        left: this.latestMousePos.x - this.tool!.size / 2,
        top: this.latestMousePos.y - this.tool!.size / 2,
        strokeWidth: 1,
        stroke: "white",
      };
      // 根据工具形状创建圆形或矩形画笔标记
      this.brushMarker =
        this.tool!.form === "circle"
          ? new fabric.Circle({
              ...common,
              radius: Math.round(this.tool!.size / 2),
            })
          : new fabric.Rect({
              ...common,
              width: this.tool!.size,
              height: this.tool!.size,
            });

      // 隐藏默认光标
      this.canvas.defaultCursor = "none";
      // 将画笔标记添加到画布
      this.canvas.add(this.brushMarker);
    } else {
      // 恢复默认光标
      this.canvas.defaultCursor = "inherit";
    }
  }

  /**
   * 释放画布包装器CSS样式
   * 重置画布包装器的CSS样式到默认状态
   */
  private releaseCanvasWrapperCSS(): void {
    // 获取画布包装器元素
    const canvasWrapper = this.canvas.getElement().parentElement;
    if (canvasWrapper !== null) {
      // 重置指针事件样式
      canvasWrapper.style.pointerEvents = "";
      // 重置z-index样式
      canvasWrapper.style.zIndex = "";
      // 重置显示样式
      canvasWrapper.style.display = "";
    }
  }

  /**
   * 释放粘贴操作
   * 清理画布，重置状态，并触发绘制完成事件
   */
  private releasePaste(): void {
    // 释放画布包装器CSS样式
    this.releaseCanvasWrapperCSS();
    // 清空画布
    this.canvas.clear();
    // 重新渲染画布
    this.canvas.renderAll();
    // 结束插入模式
    this.isInsertion = false;
    // 重置已绘制对象数组
    this.drawnObjects = this.createDrawnObjectsArray();
    // 触发绘制完成事件，传入null表示取消
    this.onDrawDone(null);
  }

  /**
   * 释放绘制状态，清理绘制相关资源
   * 移除画笔标记、重置画布样式、取消多边形绘制、清空画布并重置状态
   */
  private releaseDraw(): void {
    // 移除画笔标记
    this.removeBrushMarker();
    // 释放画布包装器CSS样式
    this.releaseCanvasWrapperCSS();
    // 如果正在绘制多边形，取消绘制
    if (this.isPolygonDrawing) {
      this.isPolygonDrawing = false;
      this.vectorDrawHandler.cancel();
    }
    // 清空画布内容
    this.canvas.clear();
    // 重新渲染画布
    this.canvas.renderAll();
    // 重置绘制状态
    this.isDrawing = false;
    this.isInsertion = false;
    // 清除重绘计时器
    this.redraw = null;
    // 重置已绘制对象数组
    this.drawnObjects = this.createDrawnObjectsArray();
  }

  /**
   * 释放编辑状态，清理编辑相关资源
   * 移除画笔标记、重置画布样式、取消多边形绘制、清空画布并重置编辑状态
   */
  private releaseEdit(): void {
    // 移除画笔标记
    this.removeBrushMarker();
    // 释放画布包装器CSS样式
    this.releaseCanvasWrapperCSS();
    // 如果正在绘制多边形，取消绘制
    if (this.isPolygonDrawing) {
      this.isPolygonDrawing = false;
      this.vectorDrawHandler.cancel();
    }
    // 清空画布内容
    this.canvas.clear();
    // 重新渲染画布
    this.canvas.renderAll();
    // 重置编辑状态
    this.isEditing = false;
    // 重置已绘制对象数组
    this.drawnObjects = this.createDrawnObjectsArray();
    // 触发编辑完成回调
    this.onEditDone(null, []);
  }

  /**
   * 根据颜色分配方式获取状态对应的颜色
   * @param state - 状态对象，包含颜色、标签或组信息
   * @returns 返回根据颜色分配方式确定的颜色字符串
   */
  private getStateColor(state: any): string {
    // 如果按实例分配颜色，返回实例的颜色
    if (this.colorBy === ColorBy.INSTANCE) {
      return state.color;
    }

    // 如果按标签分配颜色，返回标签的颜色
    if (this.colorBy === ColorBy.LABEL) {
      return state.label.color;
    }

    // 默认按组分配颜色，返回组的颜色
    return state.group.color;
  }

  /**
   * 计算已绘制对象的包围盒
   * @returns 返回包含所有已绘制对象的最小矩形边界框
   */
  private getDrawnObjectsWrappingBox(): WrappingBBox {
    // 定义边界矩形类型
    type BoundingRect = ReturnType<PropType<fabric.Polygon, "getBoundingRect">>;
    // 定义两角盒子类型，包含左上角和右下角坐标
    type TwoCornerBox = Pick<BoundingRect, "top" | "left"> & {
      right: number;
      bottom: number;
    };
    // 获取图像尺寸
    const { width, height } = this.geometry!.image;
    // 计算所有绘制对象的包围盒
    const wrappingBbox = this.drawnObjects
      // 将每个对象转换为边界矩形
      .map((obj): BoundingRect => {
        // 处理多边形对象
        if (obj instanceof fabric.Polygon) {
          // 计算多边形点的包围盒
          const bbox = computeWrappingBox(
            obj.points!.reduce<number[]>((acc, val) => {
              // 将点坐标添加到累加器
              acc.push(val.x, val.y);
              return acc;
            }, [])
          );

          return {
            left: bbox.xtl,
            top: bbox.ytl,
            width: bbox.width,
            height: bbox.height,
          };
        }

        // 处理图像对象
        if (obj instanceof fabric.Image) {
          return {
            left: obj.left ?? 0,
            top: obj.top ?? 0,
            width: obj.width ?? 0,
            height: obj.height ?? 0,
          };
        }

        // 其他类型对象直接获取边界矩形
        return obj.getBoundingRect();
      })
      // 将所有边界矩形合并为一个包围盒
      .reduce(
        (acc: TwoCornerBox, rect: BoundingRect) => {
          // 计算最小顶部坐标，确保不小于0
          acc.top = Math.floor(Math.max(0, Math.min(rect.top, acc.top)));
          // 计算最小左侧坐标，确保不小于0
          acc.left = Math.floor(Math.max(0, Math.min(rect.left, acc.left)));
          // 计算最大底部坐标，确保不大于图像高度-1
          acc.bottom = Math.floor(
            Math.min(height - 1, Math.max(rect.top + rect.height, acc.bottom))
          );
          // 计算最大右侧坐标，确保不大于图像宽度-1
          acc.right = Math.floor(
            Math.min(width - 1, Math.max(rect.left + rect.width, acc.right))
          );
          return acc;
        },
        {
          // 初始化为极大值，便于后续取最小值
          left: Number.MAX_SAFE_INTEGER,
          top: Number.MAX_SAFE_INTEGER,
          // 初始化为极小值，便于后续取最大值
          right: Number.MIN_SAFE_INTEGER,
          bottom: Number.MIN_SAFE_INTEGER,
        }
      );

    return wrappingBbox;
  }

  /**
   * 从画布中提取指定区域的图像数据
   * @param wrappingBBox - 包围盒对象，定义要提取的图像区域
   * @returns 返回指定区域的图像像素数据
   */
  private imageDataFromCanvas(wrappingBBox: WrappingBBox): Uint8ClampedArray {
    // 从画布元素获取2D渲染上下文
    const imageData = this.canvas
      .toCanvasElement()
      .getContext("2d")!
      .getImageData(
        // 左上角x坐标
        wrappingBBox.left,
        // 左上角y坐标
        wrappingBBox.top,
        // 宽度（右边界-左边界+1）
        wrappingBBox.right - wrappingBBox.left + 1,
        // 高度（下边界-上边界+1）
        wrappingBBox.bottom - wrappingBBox.top + 1
      ).data;
    return imageData;
  }

  /**
   * 更新画布的隐藏状态
   * @param value - 是否隐藏画布的布尔值
   */
  private updateHidden(value: boolean) {
    // 更新隐藏状态标志
    this.isHidden = value;

    // 需要显式更新上层画布样式，因为默认光标更新不会立即应用
    // https://github.com/fabricjs/fabric.js/issues/1456
    // 根据隐藏状态设置不透明度：隐藏时为0，显示时为空字符串
    const newOpacity = value ? "0" : "";
    // 根据隐藏状态设置光标：隐藏时继承，显示时为无
    const newCursor = value ? "inherit" : "none";
    // 设置画布元素父容器的不透明度
    this.canvas.getElement().parentElement!.style.opacity = newOpacity;
    // 获取上层画布元素
    const upperCanvas = this.canvas
      .getElement()
      .parentElement!.querySelector(".upper-canvas") as HTMLElement;
    // 如果存在上层画布，设置其光标样式
    if (upperCanvas) {
      upperCanvas.style.cursor = newCursor;
    }
    // 设置画布的默认光标
    this.canvas.defaultCursor = newCursor;
  }

  /**
   * 更新画笔工具设置
   * @param brushTool - 可选的画笔工具对象
   * @param opts - 画笔工具的可选配置参数
   */
  private updateBrushTools(brushTool?: BrushTool, opts: Partial<BrushTool> = {}): void {
    // 如果正在绘制多边形，保留已绘制的多边形（例如从多边形工具切换到画笔工具）
    if (this.isPolygonDrawing) {
      this.keepDrawnPolygon();
    }

    // 移除画笔标记
    this.removeBrushMarker();
    // 如果提供了画笔工具
    if (brushTool) {
      // 如果画笔颜色发生变化，更新所有已绘制对象的颜色
      if (brushTool.color && this.tool?.color !== brushTool.color) {
        // 从十六进制颜色创建颜色对象
        const color = fabric.Color.fromHex(brushTool.color);
        // 遍历所有已绘制对象
        for (const object of this.drawnObjects) {
          // 处理线条对象
          if (object instanceof fabric.Line) {
            // 提取当前透明度
            const alpha = +object.stroke!.split(",")[3].slice(0, -1);
            // 设置新颜色的透明度
            color.setAlpha(alpha);
            // 更新线条颜色
            object.set({ stroke: color.toRgba() });
          } else if (
            // 处理矩形、多边形和圆形对象
            object instanceof fabric.Rect ||
            object instanceof fabric.Polygon ||
            object instanceof fabric.Circle
          ) {
            // 提取当前填充透明度
            const alpha = +(object.fill as string).split(",")[3].slice(0, -1);
            // 设置新颜色的透明度
            color.setAlpha(alpha);
            // 更新填充颜色
            (object as fabric.Object).set({ fill: color.toRgba() });
          }
        }
        // 重新渲染画布
        this.canvas.renderAll();
      }

      // 合并画笔工具配置
      this.tool = { ...brushTool, ...opts };
      // 如果正在绘制或编辑，设置画笔标记
      if (this.isDrawing || this.isEditing) {
        this.setupBrushMarker();
      }

      // 更新被阻塞的工具状态
      this.updateBlockedTools();
    }

    // 如果工具类型是多边形相关
    if (this.tool?.type?.startsWith("polygon-")) {
      // 设置多边形绘制标志
      this.isPolygonDrawing = true;
      // 启用矢量绘制处理器
      this.vectorDrawHandler.draw(
        {
          enabled: true,
          shapeType: "polygon",
          // 绘制完成回调
          onDrawDone: (data: object | null) => {
            // 检查数据是否包含points属性
            if (!data || !("points" in data)) return;
            const pointData = data as { points: number[] };
            // 将点数组转换为Point对象数组
            const points = pointData.points.reduce(
              (acc: fabric.Point[], _: number, idx: number) => {
                // 只处理奇数索引（y坐标），与前面的x坐标组成点
                if (idx % 2) {
                  acc.push(
                    new fabric.Point(pointData.points[idx - 1], pointData.points[idx])
                  );
                }

                return acc;
              },
              []
            );

            // 从工具颜色创建颜色对象
            const color = fabric.Color.fromHex(this.tool!.color);
            // 根据工具类型设置透明度：减法多边形为1，其他为绘制透明度
            color.setAlpha(this.tool!.type === "polygon-minus" ? 1 : this.drawingOpacity);
            // 创建多边形对象
            const polygon = new fabric.Polygon(points, {
              fill: color.toRgba(),
              selectable: false,
              objectCaching: false,
              absolutePositioned: true,
              // 设置混合模式：减法多边形使用destination-out，其他使用xor
              globalCompositeOperation:
                this.tool!.type === "polygon-minus" ? "destination-out" : "xor",
            });

            // 添加多边形到画布
            this.canvas.add(polygon);
            // 添加到已绘制对象数组
            this.drawnObjects.push(polygon);
            // 重新渲染画布
            this.canvas.renderAll();
          },
        },
        this.geometry!
      );

      // 获取画布包装器
      const canvasWrapper = this.canvas.getElement().parentElement as HTMLDivElement;
      // 禁用画布包装器的指针事件
      canvasWrapper.style.pointerEvents = "none";
      // 设置画布包装器的层级
      canvasWrapper.style.zIndex = "0";
    }
  }

  /**
   * 更新被阻塞的工具状态
   * 根据当前绘制内容判断哪些工具应该被禁用
   */
  private updateBlockedTools(): void {
    // 如果没有绘制对象，禁用橡皮擦和减法多边形工具
    if (this.drawnObjects.length === 0) {
      this.tool!.onBlockUpdated({
        eraser: true,
        "polygon-minus": true,
      });
      return;
    }
    // 获取绘制对象的包围盒
    const wrappingBbox = this.getDrawnObjectsWrappingBox();
    // 临时移除画笔标记以获取干净的图像数据
    if (this.brushMarker) {
      this.canvas.remove(this.brushMarker);
    }
    // 从画布获取包围盒区域的图像数据
    const imageData = this.imageDataFromCanvas(wrappingBbox);
    // 恢复画笔标记
    if (this.brushMarker) {
      this.canvas.add(this.brushMarker);
    }
    // 压缩图像数据通道
    const rle = zipChannels(imageData);
    // 判断掩码是否为空（长度小于2表示空掩码）
    const emptyMask = rle.length < 2;
    // 更新工具阻塞状态：空掩码时禁用橡皮擦和减法多边形工具
    this.tool!.onBlockUpdated({
      eraser: emptyMask,
      "polygon-minus": emptyMask,
    });
  }

  /**
   * 创建已绘制对象数组
   * 返回一个代理对象，当数组内容变化时自动触发工具状态更新
   * @returns 返回带有代理功能的已绘制对象数组
   */
  private createDrawnObjectsArray(): MasksHandlerImpl["drawnObjects"] {
    // 创建基础数组
    const drawnObjects: (
      | fabric.Polygon
      | fabric.Circle
      | fabric.Rect
      | fabric.Line
      | fabric.Image
    )[] = [];
    // 创建防抖动的工具状态更新函数
    const updateBlockedToolsDebounced = debounce(this.updateBlockedTools.bind(this), 250);
    // 返回代理对象，拦截数组设置操作
    return new Proxy(drawnObjects, {
      // 拦截属性设置操作
      set(target, property, value) {
        // 设置目标属性值
        target[Number.parseInt(property as string)] = value;
        // 触发防抖动的工具状态更新
        updateBlockedToolsDebounced();
        // 返回操作成功
        return true;
      },
    });
  }

  /**
   * 构造函数 - 初始化MasksHandlerImpl实例
   * @param onDrawDone 绘制完成时的回调函数
   * @param onDrawRepeat 重复绘制时的回调函数
   * @param onEditStart 开始编辑时的回调函数
   * @param onEditDone 编辑完成时的回调函数
   * @param vectorDrawHandler 矢量绘制处理器
   * @param canvas HTML画布元素
   */
  public constructor(
    onDrawDone: MasksHandlerImpl["onDrawDone"],
    onDrawRepeat: MasksHandlerImpl["onDrawRepeat"],
    onEditStart: MasksHandlerImpl["onEditStart"],
    onEditDone: MasksHandlerImpl["onEditDone"],
    vectorDrawHandler: DrawHandler,
    canvas: HTMLCanvasElement
  ) {
    // 初始化实例属性
    this.redraw = null;
    this.isDrawing = false;
    this.isEditing = false;
    this.isMouseDown = false;
    this.isBrushSizeChanging = false;
    this.isPolygonDrawing = false;
    this.drawData = null;
    this.editData = null;
    this.drawingOpacity = 0.5;
    this.brushMarker = null;
    this.isHidden = false;
    this.colorBy = ColorBy.LABEL;
    this.isInsertion = false;
    this.resizeBrushToolLatestX = 0;
    this.drawablePolygon = null;
    this.startTimestamp = 0;
    this.geometry = null;

    // 设置回调函数
    this.onDrawDone = onDrawDone;
    this.onDrawRepeat = onDrawRepeat;
    this.onEditDone = onEditDone;
    this.onEditStart = onEditStart;
    this.vectorDrawHandler = vectorDrawHandler;

    // 创建fabric.js画布实例
    this.canvas = new fabric.Canvas(canvas, {
      containerClass: "cvat_masks_canvas_wrapper",
      fireRightClick: true,
      selection: false,
      defaultCursor: "inherit",
    });

    // 禁用图像平滑以提高像素级精度
    this.canvas.imageSmoothingEnabled = false;

    // 创建已绘制对象的代理数组
    this.drawnObjects = this.createDrawnObjectsArray();

    // 禁用画布的右键上下文菜单
    this.canvas
      .getElement()
      .parentElement!.addEventListener("contextmenu", (e: MouseEvent) =>
        e.preventDefault()
      );

    // 初始化鼠标位置
    this.latestMousePos = { x: -1, y: -1 };

    // 添加全局鼠标释放事件监听器
    window.document.addEventListener("mouseup", () => {
      this.isMouseDown = false;
      this.isBrushSizeChanging = false;
    });

    // 注册鼠标按下事件处理器
    this.canvas.on("mouse:down", (options: fabric.IEvent<MouseEvent>) => {
      const { isDrawing, isEditing, isInsertion } = this;
      // 根据鼠标按钮和修饰键设置状态
      this.isMouseDown =
        (isDrawing || isEditing) && options.e.button === 0 && !options.e.altKey;
      this.isBrushSizeChanging =
        (isDrawing || isEditing) && options.e.button === 2 && options.e.altKey;

      // 处理插入模式
      if (isInsertion) {
        // 检查是否继续插入
        const continueInserting = options.e.ctrlKey;
        // 获取绘制对象的包围盒
        const wrappingBbox = this.getDrawnObjectsWrappingBox();
        // 从画布提取图像数据
        const imageData = this.imageDataFromCanvas(wrappingBbox);
        // 压缩图像通道为RLE格式
        const rle = zipChannels(imageData);
        // 添加包围盒坐标
        rle.push(
          wrappingBbox.left,
          wrappingBbox.top,
          wrappingBbox.right,
          wrappingBbox.bottom
        );

        // 触发绘制完成回调
        this.onDrawDone(
          {
            occluded: this.drawData!.initialState.occluded,
            attributes: { ...this.drawData!.initialState.attributes },
            color: this.drawData!.initialState.color,
            objectType: this.drawData!.initialState.objectType,
            shapeType: this.drawData!.shapeType,
            points: rle,
            label: this.drawData!.initialState.label,
          },
          Date.now() - this.startTimestamp,
          continueInserting,
          this.drawData!
        );

        // 如果不继续插入，释放粘贴状态
        if (!continueInserting) {
          this.releasePaste();
        }
      } else {
        // 触发鼠标移动事件以开始绘制
        this.canvas.fire("mouse:move", options);
      }
    });

    // 注册鼠标移动事件处理器
    this.canvas.on("mouse:move", (e: fabric.IEvent<MouseEvent>) => {
      // 获取图像尺寸和旋转角度
      const {
        image: { width: imageWidth, height: imageHeight },
      } = this.geometry!;
      const { angle } = this.geometry!;
      // 获取原始坐标
      let [x, y] = [e.pointer!.x, e.pointer!.y];

      // 根据图像旋转角度调整坐标
      if (angle === 180) {
        [x, y] = [imageWidth - x, imageHeight - y];
      } else if (angle === 270) {
        [x, y] = [
          imageWidth - (y / imageHeight) * imageWidth,
          (x / imageWidth) * imageHeight,
        ];
      } else if (angle === 90) {
        [x, y] = [
          (y / imageHeight) * imageWidth,
          imageHeight - (x / imageWidth) * imageHeight,
        ];
      }

      // 创建位置对象
      const position = { x, y };
      // 获取当前状态
      const { tool, isMouseDown, isInsertion, isBrushSizeChanging } = this;

      // 处理插入模式下的对象移动
      if (isInsertion) {
        const [object] = this.drawnObjects;
        if (object && object instanceof fabric.Image) {
          // 更新图像位置，使其中心跟随鼠标
          object.left = position.x - object.width! / 2;
          object.top = position.y - object.height! / 2;
          this.canvas.renderAll();
        }
      }

      // 处理画笔大小调整
      if (
        isBrushSizeChanging &&
        tool?.type !== undefined &&
        ["brush", "eraser"].includes(tool.type)
      ) {
        // 计算鼠标移动距离
        const xDiff = e.pointer!.x - this.resizeBrushToolLatestX;
        let onUpdateConfiguration = null;
        // 获取相应的配置更新回调
        if (this.isDrawing) {
          onUpdateConfiguration = this.drawData!.onUpdateConfiguration;
        } else if (this.isEditing) {
          onUpdateConfiguration = this.editData!.onUpdateConfiguration;
        }

        // 更新画笔大小配置
        if (onUpdateConfiguration) {
          onUpdateConfiguration({
            brushTool: {
              size: Math.trunc(Math.max(1, this.tool!.size + xDiff)),
            },
          });
        }

        // 更新最新的X坐标
        this.resizeBrushToolLatestX = e.pointer!.x;
        // 阻止事件冒泡
        e.e.stopPropagation();
        return;
      }

      // 更新画笔标记位置
      if (this.brushMarker) {
        this.brushMarker.left = position.x - tool!.size / 2;
        this.brushMarker.top = position.y - tool!.size / 2;
        this.canvas.bringToFront(this.brushMarker);
        this.canvas.renderAll();
      }

      // 处理画笔/橡皮擦绘制
      if (
        isMouseDown &&
        !this.isHidden &&
        !isBrushSizeChanging &&
        tool?.type !== undefined &&
        ["brush", "eraser"].includes(tool.type)
      ) {
        // 创建颜色对象并设置透明度
        const color = fabric.Color.fromHex(tool!.color);
        color.setAlpha(tool!.type === "eraser" ? 1 : 0.5);

        // 定义通用属性
        const commonProperties = {
          selectable: false,
          evented: false,
          globalCompositeOperation: tool!.type === "eraser" ? "destination-out" : "xor",
        };

        // 定义形状属性
        const shapeProperties = {
          ...commonProperties,
          fill: color.toRgba(),
          left: position.x - tool!.size / 2,
          top: position.y - tool!.size / 2,
        };

        // 根据工具形状创建相应的fabric对象
        let shape: fabric.Circle | fabric.Rect | null = null;
        if (tool!.form === "circle") {
          shape = new fabric.Circle({
            ...shapeProperties,
            radius: Math.round(tool!.size / 2),
          });
        } else if (tool!.form === "square") {
          shape = new fabric.Rect({
            ...shapeProperties,
            width: tool!.size,
            height: tool!.size,
          });
        }

        // 添加形状到画布
        this.canvas.add(shape!);
        // 将形状添加到已绘制对象数组
        if (["brush", "eraser"].includes(tool?.type)) {
          this.drawnObjects.push(shape!);
        }

        // 添加连线以平滑掩码
        if (this.latestMousePos.x !== -1 && this.latestMousePos.y !== -1) {
          // 计算鼠标移动距离
          const dx = position.x - this.latestMousePos.x;
          const dy = position.y - this.latestMousePos.y;
          // 如果移动距离足够大，添加连线
          if (Math.sqrt(dx ** 2 + dy ** 2) > tool!.size / 2) {
            // 创建连线对象
            const line = new fabric.Line(
              [
                this.latestMousePos.x - tool!.size / 2,
                this.latestMousePos.y - tool!.size / 2,
                position.x - tool!.size / 2,
                position.y - tool!.size / 2,
              ],
              {
                ...commonProperties,
                stroke: color.toRgba(),
                strokeWidth: tool!.size,
                strokeLineCap: tool!.form === "circle" ? "round" : "square",
              }
            );

            // 添加连线到画布
            this.canvas.add(line);
            // 将连线添加到已绘制对象数组
            if (["brush", "eraser"].includes(tool?.type)) {
              this.drawnObjects.push(line);
            }
          }
        }
        // 重新渲染画布
        this.canvas.renderAll();
      } else if (tool?.type.startsWith("polygon-") && this.drawablePolygon) {
        // 更新多边形位置
        const points = this.drawablePolygon.get("points");
        if (points && points.length) {
          // 更新最后一个点的位置
          points[points.length - 1].setX(e.e.offsetX);
          points[points.length - 1].setY(e.e.offsetY);
        }
        // 重新渲染画布
        this.canvas.renderAll();
      }

      // 更新鼠标位置记录
      this.latestMousePos.x = position.x;
      this.latestMousePos.y = position.y;
      this.resizeBrushToolLatestX = position.x;
    });
  }

  /**
   * 配置掩码处理器设置
   * @param configuration 包含颜色分配方式和隐藏编辑对象设置的配置对象
   */
  public configure(configuration: Configuration): void {
    // 设置颜色分配方式（按标签、实例或组）
    this.colorBy = configuration.colorBy!;

    // 如果隐藏状态发生变化，更新画布隐藏状态
    if (this.isHidden !== configuration.hideEditedObject) {
      this.updateHidden(configuration.hideEditedObject!);
    }
  }

  /**
   * 变换画布几何属性
   * @param geometry 包含缩放、旋转、位置和尺寸等几何信息的对象
   */
  public transform(geometry: Geometry): void {
    // 更新几何属性
    this.geometry = geometry;
    // 解构几何属性
    const {
      scale,
      angle,
      image: { width, height },
      top,
      left,
    } = geometry;

    // 获取画布容器元素
    const topCanvas = this.canvas.getElement().parentElement as HTMLDivElement;
    // 如果画布尺寸发生变化，更新画布尺寸
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.setHeight(height);
      this.canvas.setWidth(width);
      this.canvas.setDimensions({ width, height });
    }

    // 设置画布容器的位置和变换
    topCanvas.style.top = `${top}px`;
    topCanvas.style.left = `${left}px`;
    topCanvas.style.transform = `scale(${scale}) rotate(${angle}deg)`;

    // 如果存在可绘制多边形，根据缩放比例调整线宽
    if (this.drawablePolygon) {
      this.drawablePolygon.set("strokeWidth", consts.BASE_STROKE_WIDTH / scale);
      this.canvas.renderAll();
    }
  }

  /**
   * 处理绘制操作，包括初始化绘制、插入掩码和完成绘制
   * @param drawData 包含绘制状态、工具设置和初始状态等信息的绘制数据对象
   */
  public draw(drawData: DrawData): void {
    // 处理启用绘制且形状类型为掩码的情况
    if (drawData.enabled && drawData.shapeType === "mask") {
      // 如果不是插入模式且初始状态为掩码，初始化插入管道
      if (!this.isInsertion && drawData.initialState?.shapeType === "mask") {
        // 从初始状态获取点数据
        const { points } = drawData.initialState;
        // 获取状态对应的颜色
        const color = fabric.Color.fromHex(
          this.getStateColor(drawData.initialState)
        ).getSource();
        // 解析包围盒坐标
        const [left, top, right, bottom] = points.slice(-4);
        // 扩展颜色通道创建图像位图
        const imageBitmap = expandChannels(color[0], color[1], color[2], points);
        // 将图像位图转换为数据URL
        imageDataToDataURL(
          imageBitmap,
          right - left + 1,
          bottom - top + 1,
          (dataURL: string) =>
            new Promise((resolve) => {
              // 从数据URL创建fabric图像对象
              fabric.Image.fromURL(
                dataURL,
                (image: fabric.Image) => {
                  try {
                    // 设置图像属性
                    image.selectable = false;
                    image.evented = false;
                    image.globalCompositeOperation = "xor";
                    image.opacity = 0.5;
                    // 添加图像到画布
                    this.canvas.add(image);
                    /*
                                    当粘贴掩码时，我们不需要MasksHandlerImpl::createDrawnObjectsArray.push中
                                    使用JS Proxy实现的额外逻辑，因为我们在这里不会使用任何绘制工具，
                                    这会导致问题，因为this.tools在这里可能未定义
                                    当在push自定义实现中使用时
                                */
                    this.drawnObjects = [image];
                    // 重新渲染画布
                    this.canvas.renderAll();
                  } finally {
                    resolve();
                  }
                },
                { left, top }
              );
            })
        );

        // 设置为插入模式
        this.isInsertion = true;
      } else {
        // 更新画笔工具设置
        this.updateBrushTools(drawData.brushTool);
        // 如果不是绘制状态，初始化绘制管道
        if (!this.isDrawing) {
          this.isDrawing = true;
          this.redraw = drawData.redraw || null;
        }
      }

      // 显示画布容器
      this.canvas.getElement().parentElement!.style.display = "block";
      // 记录开始时间戳
      this.startTimestamp = Date.now();
    }

    // 处理禁用绘制且当前为绘制状态的情况
    if (!drawData.enabled && this.isDrawing) {
      try {
        // 如果有绘制对象
        if (this.drawnObjects.length) {
          // 获取绘制对象的包围盒
          const wrappingBbox = this.getDrawnObjectsWrappingBox();
          // 从最终掩码中移除画笔标记
          this.removeBrushMarker();
          // 从画布提取图像数据
          const imageData = this.imageDataFromCanvas(wrappingBbox);
          // 压缩图像通道为RLE格式
          const rle = zipChannels(imageData);
          // 添加包围盒坐标
          rle.push(
            wrappingBbox.left,
            wrappingBbox.top,
            wrappingBbox.right,
            wrappingBbox.bottom
          );

          // 检查是否为空掩码
          const isEmptyMask = rle.length < 6;
          if (isEmptyMask) {
            // 如果为空掩码，触发绘制完成回调并传递null
            this.onDrawDone(null);
          } else {
            // 如果不为空掩码，触发绘制完成回调并传递掩码数据
            this.onDrawDone(
              {
                shapeType: this.drawData!.shapeType,
                points: rle,
                // 如果有重绘ID，添加到结果中
                ...(Number.isInteger(this.redraw) ? { clientID: this.redraw } : {}),
              },
              Date.now() - this.startTimestamp,
              drawData.continue,
              this.drawData!
            );
          }
        } else {
          // 如果没有绘制对象，触发绘制完成回调并传递null
          this.onDrawDone(null);
        }
      } finally {
        // 释放绘制状态
        this.releaseDraw();
      }

      // 如果需要继续绘制
      if (drawData.continue) {
        // 创建新的绘制数据对象
        const newDrawData = {
          ...this.drawData,
          brushTool: { ...this.tool! },
          ...drawData,
          enabled: true,
          shapeType: "mask",
        };

        // 触发重复绘制回调
        this.onDrawRepeat({ enabled: true, shapeType: "mask" });
        this.onDrawRepeat(newDrawData);
        return;
      }
    }

    // 更新绘制数据
    this.drawData = drawData;
  }

  /**
   * 处理掩码编辑操作
   * @param editData - 掩码编辑数据，包含启用状态、画笔工具和编辑状态信息
   */
  public edit(editData: MasksEditData): void {
    // 检查是否启用编辑且状态类型为掩码
    if (editData.enabled && editData.state.shapeType === "mask") {
      // 如果尚未开始编辑，则启动编辑管道
      if (!this.isEditing) {
        // 显示画布元素
        this.canvas.getElement().parentElement!.style.display = "block";
        // 获取编辑状态的点数据
        const { points } = editData.state;
        // 根据状态获取颜色并转换为RGB源值
        const color = fabric.Color.fromHex(
          this.getStateColor(editData.state)
        ).getSource();
        // 从点数据中提取边界坐标
        const [left, top, right, bottom] = points.slice(-4);
        // 扩展颜色通道创建图像位图
        const imageBitmap = expandChannels(color[0], color[1], color[2], points);
        // 将图像位图转换为数据URL
        imageDataToDataURL(
          imageBitmap,
          right - left + 1, // 计算宽度
          bottom - top + 1, // 计算高度
          (dataURL: string) =>
            new Promise((resolve) => {
              // 从数据URL创建fabric图像对象
              fabric.Image.fromURL(
                dataURL,
                (image: fabric.Image) => {
                  try {
                    // 设置图像属性
                    image.selectable = false; // 禁用选择
                    image.evented = false; // 禁用事件
                    image.globalCompositeOperation = "xor"; // 设置全局合成操作
                    image.opacity = 0.5; // 设置透明度
                    // 将图像添加到画布
                    this.canvas.add(image);
                    // 将图像添加到已绘制对象数组
                    this.drawnObjects.push(image);
                    // 渲染画布
                    this.canvas.renderAll();
                  } finally {
                    // 解析Promise
                    resolve();
                  }
                },
                { left, top }
              ); // 设置图像位置
            })
        );

        // 标记为编辑状态
        this.isEditing = true;
        // 记录开始时间戳
        this.startTimestamp = Date.now();
        // 触发编辑开始回调
        this.onEditStart(editData.state);
      }
    }

    // 更新画笔工具设置
    this.updateBrushTools(
      editData.brushTool,
      editData.state ? { color: this.getStateColor(editData.state) } : {}
    );

    // 如果编辑被禁用且当前处于编辑状态，则完成编辑
    if (!editData.enabled && this.isEditing) {
      try {
        // 如果有已绘制对象
        if (this.drawnObjects.length) {
          // 获取已绘制对象的包围盒
          const wrappingBbox = this.getDrawnObjectsWrappingBox();
          // 移除画笔标记，避免出现在最终掩码中
          this.removeBrushMarker();
          // 从画布获取图像数据
          const imageData = this.imageDataFromCanvas(wrappingBbox);
          // 压缩图像数据通道为RLE格式
          const rle = zipChannels(imageData);
          // 添加包围盒坐标到RLE数据
          rle.push(
            wrappingBbox.left,
            wrappingBbox.top,
            wrappingBbox.right,
            wrappingBbox.bottom
          );
          // 检查是否为空掩码（RLE数据长度小于6表示只有包围盒坐标）
          const isEmptyMask = rle.length < 6;
          // 根据掩码是否为空触发相应的完成回调
          if (isEmptyMask) {
            this.onEditDone(null, []);
          } else {
            this.onEditDone(this.editData!.state, rle);
          }
        }
      } finally {
        // 释放编辑状态并清理资源
        this.releaseEdit();
      }
    }
    // 保存编辑数据
    this.editData = editData;
  }

  /**
   * 获取启用状态
   * @returns 如果当前正在绘制、编辑或插入操作中，则返回true，否则返回false
   */
  get enabled(): boolean {
    return this.isDrawing || this.isEditing || this.isInsertion;
  }

  /**
   * 取消当前操作
   * 如果正在绘制或插入，则释放绘制状态；如果正在编辑，则释放编辑状态
   */
  public cancel(): void {
    // 如果正在绘制或插入操作，则释放绘制状态
    if (this.isDrawing || this.isInsertion) {
      this.releaseDraw();
    }

    // 如果正在编辑操作，则释放编辑状态
    if (this.isEditing) {
      this.releaseEdit();
    }
  }
}
