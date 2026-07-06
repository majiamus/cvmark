import type { Master } from "../events/master";

import { type CanvasController, CanvasControllerImpl } from "./canvasController";
import {
  type CanvasHint as _CanvasHint,
  type FrameData as _FrameData,
  type HighlightSeverity as _HighlightSeverity,
  type InteractionData as _InteractionData,
  type InteractionResult as _InteractionResult,
  type CanvasModel,
  CanvasModelImpl,
  type Configuration,
  type DrawData,
  type Geometry,
  type GroupData,
  type JoinData,
  type MasksEditData,
  type MergeData,
  Mode,
  type PolyEditData,
  RectDrawingMethod,
  type SliceData,
  type SplitData,
} from "./canvasModel";
import { type CanvasView, CanvasViewImpl } from "./canvasView";
import "../styles/canvas.scss";

/**
 * 画布接口，定义了画布组件的所有公共方法和属性
 * 提供了画布渲染、交互、配置和状态管理的完整功能
 */
interface Canvas {
  /**
   * 获取画布的HTML元素
   * @returns 画布的DOM元素
   */
  html(): HTMLDivElement;

  /**
   * 设置画布的帧数据和对象状态
   * @param frameData - 帧数据，包含图像信息等
   * @param objectStates - 对象状态数组，包含所有标注对象的状态
   * @param zLayer - 可选的Z层级，用于3D场景中的层级管理
   */
  setup(frameData: FrameData, objectStates: any[], zLayer?: number): void;

  /**
   * 将SVG坐标转换为画布坐标
   * @param points - SVG坐标点数组
   * @returns 转换后的画布坐标点数组
   */
  translateFromSVG(points: number[]): number[];

  /**
   * 激活指定的对象或属性
   * @param clientID - 要激活的对象的元素ID，null表示取消激活
   * @param attributeID - 可选，要激活的属性ID
   */
  activate(clientID: number | null, attributeID?: number): void;

  /**
   * 高亮显示指定的对象
   * @param clientIDs - 要高亮显示的对象ID数组，null表示取消高亮
   * @param severity - 高亮严重程度，null表示默认程度
   */
  highlight(clientIDs: number[] | null, severity: HighlightSeverity | null): void;

  /**
   * 旋转画布
   * @param rotationAngle - 旋转角度（弧度）
   */
  rotate(rotationAngle: number): void;

  /**
   * 聚焦到指定对象
   * @param clientID - 要聚焦的对象ID
   * @param padding - 可选，聚焦时的边距大小
   */
  focus(clientID: number, padding?: number): void;

  /**
   * 自适应调整画布视图，使所有内容可见
   */
  fit(): void;

  /**
   * 处理用户交互数据
   * @param interactionData - 交互数据，包含鼠标事件和交互类型
   */
  interact(interactionData: InteractionData): void;

  /**
   * 绘制图形
   * @param drawData - 绘制数据，包含图形类型和绘制参数
   */
  draw(drawData: DrawData): void;

  /**
   * 编辑图形
   * @param editData - 编辑数据，可以是掩码编辑或多边形编辑数据
   */
  edit(editData: MasksEditData | PolyEditData): void;

  /**
   * 组合对象
   * @param groupData - 组合数据，包含要组合的对象信息
   */
  group(groupData: GroupData): void;

  /**
   * 连接对象
   * @param joinData - 连接数据，包含要连接的对象信息
   */
  join(joinData: JoinData): void;

  /**
   * 切割图形
   * @param sliceData - 切割数据，包含切割线和目标图形
   */
  slice(sliceData: SliceData): void;

  /**
   * 分割图形
   * @param splitData - 分割数据，包含分割参数
   */
  split(splitData: SplitData): void;

  /**
   * 合并对象
   * @param mergeData - 合并数据，包含要合并的对象信息
   */
  merge(mergeData: MergeData): void;

  /**
   * 选择对象
   * @param objectState - 要选择的对象状态
   */
  select(objectState: any): void;

  /**
   * 调整画布大小以适应容器
   */
  fitCanvas(): void;

  /**
   * 启用或禁用区域选择功能
   * @param enable - 是否启用区域选择
   */
  selectRegion(enable: boolean): void;

  /**
   * 启用或禁用画布拖拽功能
   * @param enable - 是否启用画布拖拽
   */
  dragCanvas(enable: boolean): void;

  /**
   * 启用或禁用画布缩放功能
   * @param enable - 是否启用画布缩放
   */
  zoomCanvas(enable: boolean): void;

  /**
   * 获取当前画布模式
   * @returns 当前画布模式
   */
  mode(): Mode;

  /**
   * 取消当前操作
   */
  cancel(): void;

  /**
   * 配置画布
   * @param configuration - 画布配置对象
   */
  configure(configuration: Configuration): void;

  /**
   * 检查是否可以切换到下一帧
   * @returns 是否可以切换帧
   */
  isAbleToChangeFrame(): boolean;

  /**
   * 销毁画布，释放资源
   */
  destroy(): void;

  /** 播放视频 */
  playVideo(): void;

  /** 暂停视频 */
  pauseVideo(): void;

  /**
   * 跳转到指定时间
   * @param time - 时间（秒）
   */
  seekVideo(time: number): void;

  /**
   * 获取画布几何信息
   */
  readonly geometry: Geometry;
}

/**
 * 画布实现类，实现了Canvas接口
 * 采用MVC架构模式，包含模型、控制器和视图三个组件
 */
class CanvasImpl implements Canvas {
  //#region  属性定义

  /** 画布模型，负责数据管理和业务逻辑 */
  private model: CanvasModel & Master;
  /** 画布控制器，负责处理用户输入和事件 */
  private controller: CanvasController;
  /** 画布视图，负责渲染和显示 */
  private view: CanvasView;

  //#endregion

  //#region 构造函数
  /**
   * 构造函数，初始化画布的模型、控制器和视图组件
   */
  public constructor() {
    this.model = new CanvasModelImpl();
    this.controller = new CanvasControllerImpl(this.model);
    this.view = new CanvasViewImpl(this.model, this.controller);
  }
  //#endregion

  /**
   * 获取画布的HTML元素
   * @returns 画布的DOM元素
   */
  public html(): HTMLDivElement {
    return this.view.html();
  }

  /**
   * 设置画布的帧数据和对象状态
   * @param frameData - 帧数据，包含图像信息等
   * @param objectStates - 对象状态数组，包含所有标注对象的状态
   * @param zLayer - Z层级，默认为0，用于3D场景中的层级管理
   */
  public setup(frameData: FrameData, objectStates: any[], zLayer: number = 0): void {
    this.model.setup(frameData, objectStates, zLayer);
  }

  /**
   * 将SVG坐标转换为画布坐标
   * @param points - SVG坐标点数组
   * @returns 转换后的画布坐标点数组
   */
  public translateFromSVG(points: number[]): number[] {
    return this.view.translateFromSVG(points);
  }

  /**
   * 调整画布大小以适应容器
   */
  public fitCanvas(): void {
    // 获取视图元素的宽度和高度，并调整画布大小
    this.model.fitCanvas(this.view.html().clientWidth, this.view.html().clientHeight);
  }

  /**
   * 启用或禁用区域选择功能
   * @param enable - 是否启用区域选择
   */
  public selectRegion(enable: boolean): void {
    this.model.selectRegion(enable);
  }

  /**
   * 启用或禁用画布拖拽功能
   * @param enable - 是否启用画布拖拽
   */
  public dragCanvas(enable: boolean): void {
    this.model.dragCanvas(enable);
  }

  /**
   * 启用或禁用画布缩放功能
   * @param enable - 是否启用画布缩放
   */
  public zoomCanvas(enable: boolean): void {
    this.model.zoomCanvas(enable);
  }
  /**
   * 激活指定的对象或属性
   * @param clientID - 要激活的对象的元素ID，null表示取消激活
   * @param attributeID - 要激活的属性ID，默认为null
   */
  public activate(clientID: number | null, attributeID: number | null = null): void {
    this.model.activate(clientID, attributeID);
  }

  /**
   * 高亮显示指定的对象
   * @param clientIDs - 要高亮显示的对象ID数组
   * @param severity - 高亮严重程度，默认为null表示默认程度
   */
  public highlight(clientIDs: number[], severity: HighlightSeverity | null = null): void {
    this.model.highlight(clientIDs, severity);
  }

  /**
   * 旋转画布
   * @param rotationAngle - 旋转角度（弧度）
   */
  public rotate(rotationAngle: number): void {
    this.model.rotate(rotationAngle);
  }

  /**
   * 聚焦到指定对象
   * @param clientID - 要聚焦的对象ID
   * @param padding - 聚焦时的边距大小，默认为0
   */
  public focus(clientID: number, padding = 0): void {
    this.model.focus(clientID, padding);
  }

  /**
   * 自适应调整画布视图，使所有内容可见
   */
  public fit(): void {
    this.model.fit();
  }

  /**
   * 处理用户交互数据
   * @param interactionData - 交互数据，包含鼠标事件和交互类型
   */
  public interact(interactionData: InteractionData): void {
    this.model.interact(interactionData);
  }

  /**
   * 绘制图形
   * @param drawData - 绘制数据，包含图形类型和绘制参数
   */
  public draw(drawData: DrawData): void {
    this.model.draw(drawData);
  }

  /**
   * 编辑图形
   * @param editData - 编辑数据，可以是掩码编辑或多边形编辑数据
   */
  public edit(editData: MasksEditData | PolyEditData): void {
    this.model.edit(editData);
  }

  /**
   * 分割图形
   * @param splitData - 分割数据，包含分割参数
   */
  public split(splitData: SplitData): void {
    this.model.split(splitData);
  }

  /**
   * 组合对象
   * @param groupData - 组合数据，包含要组合的对象信息
   */
  public group(groupData: GroupData): void {
    this.model.group(groupData);
  }

  /**
   * 连接对象
   * @param joinData - 连接数据，包含要连接的对象信息
   */
  public join(joinData: JoinData): void {
    this.model.join(joinData);
  }

  /**
   * 切割图形
   * @param sliceData - 切割数据，包含切割线和目标图形
   */
  public slice(sliceData: SliceData): void {
    this.model.slice(sliceData);
  }

  /**
   * 合并对象
   * @param mergeData - 合并数据，包含要合并的对象信息
   */
  public merge(mergeData: MergeData): void {
    this.model.merge(mergeData);
  }

  /**
   * 选择对象
   * @param objectState - 要选择的对象状态
   */
  public select(objectState: any): void {
    this.model.select(objectState);
  }

  /**
   * 获取当前画布模式
   * @returns 当前画布模式
   */
  public mode(): Mode {
    return this.model.mode;
  }

  /**
   * 取消当前操作
   */
  public cancel(): void {
    this.model.cancel();
  }

  /**
   * 配置画布
   * @param configuration - 画布配置对象
   */
  public configure(configuration: Configuration): void {
    this.model.configure(configuration);
  }

  /**
   * 检查是否可以切换到下一帧
   * @returns 是否可以切换帧
   */
  public isAbleToChangeFrame(): boolean {
    return this.model.isAbleToChangeFrame();
  }

  /**
   * 获取画布几何信息
   * @returns 画布几何信息对象
   */
  public get geometry(): Geometry {
    return this.model.geometry;
  }

  /**
   * 销毁画布，释放资源
   */
  public destroy(): void {
    this.model.destroy();
  }

  /** 播放视频 */
  public playVideo(): void {
    this.view.playVideo();
  }

  /** 暂停视频 */
  public pauseVideo(): void {
    this.view.pauseVideo();
  }

  /**
   * 跳转到指定时间
   * @param time - 时间（秒）
   */
  public seekVideo(time: number): void {
    this.view.seekVideo(time);
  }
}

export type InteractionData = _InteractionData;
export type CanvasHint = _CanvasHint;
export type InteractionResult = _InteractionResult;
export type HighlightSeverity = _HighlightSeverity;
export type FrameData = _FrameData;

export { CanvasImpl as Canvas, Mode as CanvasMode, RectDrawingMethod };
