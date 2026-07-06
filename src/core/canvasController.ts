import type {
  ActiveElement,
  CanvasModel,
  Configuration,
  DrawData,
  FocusData,
  Geometry,
  GroupData,
  HighlightedElements,
  InteractionData,
  JoinData,
  MasksEditData,
  MergeData,
  Mode,
  PolyEditData,
  Position,
  SliceData,
  SplitData,
} from "./canvasModel";

/**
 * 画布控制器接口，定义画布控制器的所有属性和方法
 * 负责处理用户输入和事件，协调模型和视图之间的交互
 */
export interface CanvasController {
  //#region 接口属性定义
  /** 只读属性：当前激活的元素信息 */
  readonly activeElement: ActiveElement;
  /** 只读属性：画布上的所有对象 */
  readonly objects: any[];
  /** 只读属性：聚焦数据，包含聚焦对象的信息 */
  readonly focusData: FocusData;
  /** 只读属性：绘制数据，包含图形类型和绘制参数 */
  readonly drawData: DrawData;
  /** 只读属性：编辑数据，可以是掩码编辑或多边形编辑数据 */
  readonly editData: MasksEditData | PolyEditData;
  /** 只读属性：交互数据，包含鼠标事件和交互类型 */
  readonly interactionData: InteractionData;
  /** 只读属性：合并数据，包含要合并的对象信息 */
  readonly mergeData: MergeData;
  /** 只读属性：分割数据，包含分割参数 */
  readonly splitData: SplitData;
  /** 只读属性：组合数据，包含要组合的对象信息 */
  readonly groupData: GroupData;
  /** 只读属性：连接数据，包含要连接的对象信息 */
  readonly joinData: JoinData;
  /** 只读属性：切割数据，包含切割线和目标图形 */
  readonly sliceData: SliceData;
  /** 只读属性：Z层级，用于3D场景中的层级管理 */
  readonly zLayer: number | null;
  /** 只读属性：画布配置对象 */
  readonly configuration: Configuration;
  /** 只读属性：高亮显示的元素集合 */
  readonly highlightedElements: HighlightedElements;
  /** 只读属性：当前选中的对象 */
  readonly selected: any;
  /** 读写属性：当前画布模式 */
  mode: Mode;
  /** 读写属性：画布几何信息 */
  geometry: Geometry;

  //#endregion

  //#region 接口方法定义

  /**
   * 缩放画布
   * @param x - 鼠标X坐标
   * @param y - 鼠标Y坐标
   * @param deltaY - 滚轮滚动量，正值表示放大，负值表示缩小
   */
  zoom(x: number, y: number, deltaY: number): void;
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
   * 启用拖拽功能
   * @param x - 鼠标X坐标
   * @param y - 鼠标Y坐标
   */
  enableDrag(x: number, y: number): void;
  /**
   * 执行拖拽操作
   * @param x - 鼠标X坐标
   * @param y - 鼠标Y坐标
   */
  drag(x: number, y: number): void;
  /**
   * 禁用拖拽功能
   */
  disableDrag(): void;
  /**
   * 自适应调整画布视图，使所有内容可见
   */
  fit(): void;

  //#endregion
}

/**
 * 画布控制器实现类，实现了CanvasController接口
 * 负责处理用户输入和事件，协调模型和视图之间的交互
 */
export class CanvasControllerImpl implements CanvasController {
  // #region  属性定义

  /** 画布模型，负责数据管理和业务逻辑 */
  private model: CanvasModel;
  /** 上一次拖拽位置，用于计算拖拽偏移量 */
  private lastDragPosition: Position;
  /** 是否正在拖拽的标志 */
  private isDragging: boolean;

  // #endregion

  // #region getters and setters

  /**
   * 获取当前选中的对象
   * @returns 当前选中的对象
   */
  public get selected(): any {
    return this.model.selected;
  }

  /**
   * 获取合并数据
   * @returns 合并数据，包含要合并的对象信息
   */
  public get mergeData(): MergeData {
    return this.model.mergeData;
  }

  /**
   * 获取分割数据
   * @returns 分割数据，包含分割参数
   */
  public get splitData(): SplitData {
    return this.model.splitData;
  }

  /**
   * 获取组合数据
   * @returns 组合数据，包含要组合的对象信息
   */
  public get groupData(): GroupData {
    return this.model.groupData;
  }

  /**
   * 获取连接数据
   * @returns 连接数据，包含要连接的对象信息
   */
  public get joinData(): JoinData {
    return this.model.joinData;
  }

  /**
   * 获取切割数据
   * @returns 切割数据，包含切割线和目标图形
   */
  public get sliceData(): SliceData {
    return this.model.sliceData;
  }

  /**
   * 获取交互数据
   * @returns 交互数据，包含鼠标事件和交互类型
   */
  public get interactionData(): InteractionData {
    return this.model.interactionData;
  }

  /**
   * 获取编辑数据
   * @returns 编辑数据，可以是掩码编辑或多边形编辑数据
   */
  public get editData(): MasksEditData | PolyEditData {
    return this.model.editData;
  }

  /**
   * 获取绘制数据
   * @returns 绘制数据，包含图形类型和绘制参数
   */
  public get drawData(): DrawData {
    return this.model.drawData;
  }

  /**
   * 获取高亮显示的元素集合
   * @returns 高亮显示的元素集合
   */
  public get highlightedElements(): HighlightedElements {
    return this.model.highlightedElements;
  }

  /**
   * 获取聚焦数据
   * @returns 聚焦数据，包含聚焦对象的信息
   */
  public get focusData(): FocusData {
    return this.model.focusData;
  }

  /**
   * 获取画布配置对象
   * @returns 画布配置对象
   */
  public get configuration(): Configuration {
    return this.model.configuration;
  }

  /**
   * 获取当前激活的元素信息
   * @returns 当前激活的元素信息
   */
  public get activeElement(): ActiveElement {
    return this.model.activeElement;
  }

  /**
   * 获取当前Z层级
   * @returns 当前Z层级，如果未设置则返回null
   */
  public get zLayer(): number | null {
    return this.model.zLayer;
  }

  /**
   * 获取画布上的所有对象
   * @returns 对象数组
   */
  public get objects(): any[] {
    return this.model.objects;
  }

  /**
   * 设置画布模式
   * @param value - 画布模式
   */
  public set mode(value: Mode) {
    this.model.mode = value;
  }

  /**
   * 启用拖拽功能，记录初始拖拽位置
   * @param x - 鼠标X坐标
   * @param y - 鼠标Y坐标
   */
  public enableDrag(x: number, y: number): void {
    // 记录拖拽起始位置
    this.lastDragPosition = {
      x,
      y,
    };
    // 设置拖拽状态为启用
    this.isDragging = true;
  }

  /**
   * 绘制图形
   * @param drawData - 绘制数据，包含图形类型和绘制参数
   */
  public draw(drawData: DrawData): void {
    this.model.draw(drawData);
  }

  /**
   * 执行拖拽操作，计算偏移量并移动画布
   * @param x - 鼠标X坐标
   * @param y - 鼠标Y坐标
   */
  public drag(x: number, y: number): void {
    if (this.isDragging) {
      // 计算Y轴偏移量
      const topOffset: number = y - this.lastDragPosition.y;
      // 计算X轴偏移量
      const leftOffset: number = x - this.lastDragPosition.x;
      // 更新最后拖拽位置
      this.lastDragPosition = {
        x,
        y,
      };
      // 移动画布
      this.model.move(topOffset, leftOffset);
    }
  }

  /**
   * 禁用拖拽功能
   */
  public disableDrag(): void {
    this.isDragging = false;
  }

  /**
   * 编辑图形
   * @param editData - 编辑数据，可以是掩码编辑或多边形编辑数据
   */
  public edit(editData: MasksEditData | PolyEditData): void {
    this.model.edit(editData);
  }

  /**
   * 缩放画布
   * @param x - 鼠标X坐标
   * @param y - 鼠标Y坐标
   * @param deltaY - 滚轮滚动量，正值表示放大，负值表示缩小
   */
  public zoom(x: number, y: number, deltaY: number): void {
    this.model.zoom(x, y, deltaY);
  }

  /**
   * 获取当前画布模式
   * @returns 当前画布模式
   */
  public get mode(): Mode {
    return this.model.mode;
  }

  /**
   * 获取画布几何信息
   * @returns 画布几何信息对象
   */
  public get geometry(): Geometry {
    return this.model.geometry;
  }

  /**
   * 设置画布几何信息
   * @param geometry - 画布几何信息对象
   */
  public set geometry(geometry: Geometry) {
    this.model.geometry = geometry;
  }
  // #endregion

  //#region 构造函数
  /**
   * 构造函数，初始化画布控制器
   * @param model - 画布模型实例
   */
  public constructor(model: CanvasModel) {
    this.model = model;
    this.lastDragPosition = { x: 0, y: 0 };
    this.isDragging = false;
  }
  //#endregion

  public fit(): void {
    this.model.fit();
  }
}
