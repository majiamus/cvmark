import { fabric } from "fabric";
import polylabel from "polylabel";
import * as SVG from "svg.js";

// 挂载到全局，确保插件能找到
(window as any).SVG = SVG;

import "svg.draggable.js";
import "svg.resize.js";
import "svg.select.js";
import consts from "../consts/consts";
import type { Listener, Master } from "../events/master";
import {
  type AutoborderHandler,
  AutoborderHandlerImpl,
} from "../handlers/autoborderHandler";
import { type DrawHandler, DrawHandlerImpl } from "../handlers/drawHandler";
import { type EditHandler, EditHandlerImpl } from "../handlers/editHandler";
import { type GroupHandler, GroupHandlerImpl } from "../handlers/groupHandler";
import {
  type InteractionHandler,
  InteractionHandlerImpl,
} from "../handlers/interactionHandler";
import { type MasksHandler, MasksHandlerImpl } from "../handlers/masksHandler";
import { type MergeHandler, MergeHandlerImpl } from "../handlers/mergeHandler";
import { type SliceHandler, SliceHandlerImpl } from "../handlers/sliceHandler";
import { type SplitHandler, SplitHandlerImpl } from "../handlers/splitHandler";
import { type ZoomHandler, ZoomHandlerImpl } from "../handlers/zoomHandler";
import { type ObjectSelector, ObjectSelectorImpl } from "../selector/objectSelector";
import { type RegionSelector, RegionSelectorImpl } from "../selector/regionSelector";
import {
  clamp,
  composeShapeDimensions,
  type DrawnState,
  displayShapeSize,
  expandChannels,
  getRoundedRotation,
  imageDataToDataURL,
  makeSVGFromTemplate,
  parsePoints,
  pointsToNumberArray,
  readPointsFromShape,
  type ShapeSizeElement,
  scalarProduct,
  setupSkeletonEdges,
  stringifyPoints,
  translateFromCanvas,
  translateFromSVG,
  translateToCanvas,
  translateToSVG,
  vectorLength,
  zipChannels,
} from "../utils/shared";

import type { CanvasController } from "./canvasController";
import {
  type ActiveElement,
  type CanvasHint,
  type CanvasModel,
  ColorBy,
  type Configuration,
  type DrawData,
  FrameZoom,
  type Geometry,
  type GroupData,
  type HighlightedElements,
  HighlightSeverity,
  type InteractionData,
  type InteractionResult,
  type JoinData,
  type MergeData,
  Mode,
  type SplitData,
  UpdateReasons,
} from "./canvasModel";

/**
 * 画布视图接口
 * 定义了画布视图的基本操作方法，包括DOM元素获取、冲突区域设置和坐标转换功能
 */
export interface CanvasView {
  //#region 接口方法定义

  /**
   * 获取画布的HTML DOM元素
   * @returns 画布的HTMLDivElement对象
   */
  html(): HTMLDivElement;

  /**
   * 将SVG坐标转换为画布坐标
   * 将SVG坐标系中的点数组转换为画布坐标系中的点数组
   * @param points - SVG坐标系中的点数组
   * @returns 转换后的画布坐标系中的点数组
   */
  translateFromSVG(points: number[]): number[];

  /** 播放视频 */
  playVideo(): void;

  /** 暂停视频 */
  pauseVideo(): void;

  /**
   * 跳转到指定时间
   * @param time - 时间（秒）
   */
  seekVideo(time: number): void;

  //#endregion
}

/**
 * 画布视图实现类
 * 实现了CanvasView接口和Listener接口，负责画布的渲染和交互处理
 * 提供了DOM元素管理、冲突区域处理、坐标转换等画布视图功能
 */
export class CanvasViewImpl implements CanvasView, Listener {
  // #region 属性定义

  // DOM元素相关属性
  /** 主容器，包含所有子元素 */
  private canvas: HTMLDivElement;
  /** SVG文本层，用于显示对象标签和标注 */
  private text: SVGSVGElement;
  /** SVG.js容器，包含所有文本元素 */
  private adoptedText: SVG.Container;
  /** 背景画布，用于渲染图像 */
  private background: HTMLCanvasElement;
  /** 遮罩内容画布，用于渲染对象遮罩 */
  private masksContent: HTMLCanvasElement;
  /** SVG内容层，包含所有图形和对象 */
  private content: SVGSVGElement;
  /** SVG.js容器，包含所有内容元素 */
  private adoptedContent: SVG.Container;
  /** 附件面板，用于显示附加内容 */
  private attachmentBoard: HTMLDivElement;

  // 控制器和管理对象
  /** 画布控制器，管理画布状态和操作 */
  private controller: CanvasController;
  /** SVG图形集合，按ID索引 */
  private svgShapes: Record<number, SVG.Shape>;
  /** SVG文本集合，按ID索引 */
  private svgTexts: Record<number, SVG.Text>;
  /** 图像加载状态标志 */
  private isImageLoading: boolean;
  /** 绘制状态集合，记录每个对象的绘制状态 */
  private drawnStates: Record<number, DrawnState>;
  /** 几何信息对象，包含画布尺寸、偏移等信息 */
  private geometry: Geometry;

  // 各种处理程序
  /** 活动元素管理器，管理当前活动元素 */
  private activeElement: ActiveElement;
  /** 高亮元素管理器，管理高亮显示的元素 */
  private highlightedElements: HighlightedElements;
  /** 配置对象，包含画布配置信息 */
  private configuration: Configuration;

  /** 区域选择器，处理区域选择操作 */
  private regionSelector: RegionSelector;
  /** 对象选择器，处理对象选择操作 */
  private objectSelector: ObjectSelector;

  /** 绘制处理程序，处理绘制操作 */
  private drawHandler: DrawHandler;
  /** 遮罩处理程序，处理遮罩操作 */
  private masksHandler: MasksHandler;
  /** 编辑处理程序，处理编辑操作 */
  private editHandler: EditHandler;
  /** 合并处理程序，处理对象合并操作 */
  private mergeHandler: MergeHandler;
  /** 分割处理程序，处理对象分割操作 */
  private splitHandler: SplitHandler;
  /** 分组处理程序，处理对象分组操作 */
  private groupHandler: GroupHandler;
  /** 切片处理程序，处理对象切片操作 */
  private sliceHandler: SliceHandler;
  /** 缩放处理程序，处理缩放操作 */
  private zoomHandler: ZoomHandler;
  /** 自动边框处理程序，处理自动边框操作 */
  private autoborderHandler: AutoborderHandler;
  /** 交互处理程序，处理用户交互 */
  private interactionHandler: InteractionHandler;

  // 状态和配置
  /** 按角度调整大小的阈值 */
  private snapToAngleResize: number;
  /** 当前可拖动的图形 */
  private draggableShape: SVG.Shape | null;
  /** 当前可调整大小的图形 */
  private resizableShape: SVG.Shape | null;
  /** Ctrl键按下状态标志 */
  private ctrlPressed: boolean;
  /** 内部对象标志集合，控制对象在不同操作阶段的可见性 */
  private innerObjectsFlags: {
    /** 绘制时隐藏的对象标志 */
    drawHidden: Record<number, boolean>;
    /** 编辑时隐藏的对象标志 */
    editHidden: Record<number, boolean>;
    /** 切片时隐藏的对象标志 */
    sliceHidden: Record<number, boolean>;
  };

  // #endregion

  //#region getters and setters

  /**
   * 设置画布模式
   * @param value - 新的画布模式
   */
  private set mode(value: Mode) {
    this.controller.mode = value;
  }

  /**
   * 获取当前画布模式
   * @returns 当前画布模式
   */
  private get mode(): Mode {
    return this.controller.mode;
  }

  //#endregion

  //#region 视频

  /** 视频元素，用于渲染视频 */
  private videoElement: HTMLVideoElement;
  /** 视频播放状态 */
  private isVideoPlaying: boolean = false;

  /**
   * 播放视频
   */
  public playVideo(): void {
    if (this.videoElement) {
      this.videoElement.play().catch((err) => {
        // 忽略 AbortError
        if (err.name !== "AbortError") {
          console.warn("Video play error:", err);
        }
      });
    }
  }

  /**
   * 暂停视频
   */
  public pauseVideo(): void {
    if (this.videoElement) {
      this.videoElement.pause();
    }
  }

  /**
   * 跳转到指定时间
   * @param time - 时间（秒）
   */
  public seekVideo(time: number): void {
    if (this.videoElement) {
      this.videoElement.currentTime = time;
    }
  }

  /**
   * 切换到图像模式
   */
  public switchToImageMode(): void {
    if (this.videoElement) {
      // 暂停视频
      this.pauseVideo();

      // 隐藏视频元素，显示背景画布
      this.videoElement.style.display = "none";
      this.background.style.display = "block";
    }
  }

  //#endregion

  //#region 构造函数
  /**
   * CanvasViewImpl构造函数
   * 初始化画布视图，创建所有必要的HTML元素、事件处理器和API处理器
   *
   * @param model - 画布数据模型，包含配置和状态信息
   * @param controller - 画布控制器，处理用户交互和状态管理
   */
  public constructor(model: CanvasModel & Master, controller: CanvasController) {
    // 初始化控制器引用
    this.controller = controller;
    // 获取几何信息引用
    this.geometry = controller.geometry;

    // 初始化存储对象状态的映射
    this.svgShapes = {}; // 存储SVG图形元素
    this.svgTexts = {}; // 存储SVG文本元素
    this.drawnStates = {}; // 存储绘制状态

    // 初始化活动元素
    this.activeElement = {
      clientID: null,
      attributeID: null,
    };

    // 初始化高亮元素
    this.highlightedElements = {
      elementsIDs: [],
      severity: null,
    };

    // 获取配置信息
    this.configuration = model.configuration;

    // 设置初始模式为空闲
    this.mode = Mode.IDLE;

    // 设置角度捕捉的默认值
    this.snapToAngleResize = consts.SNAP_TO_ANGLE_RESIZE_DEFAULT;

    // 初始化控制键状态
    this.ctrlPressed = false;

    // 初始化内部对象标志，用于跟踪对象的隐藏状态
    this.innerObjectsFlags = {
      drawHidden: {}, // 绘制时隐藏的对象
      editHidden: {}, // 编辑时隐藏的对象
      sliceHidden: {}, // 切片时隐藏的对象
    };

    // 初始化图像加载状态
    this.isImageLoading = true;

    // 初始化可拖动和可调整大小的图形
    this.draggableShape = null;
    this.resizableShape = null;

    // 创建HTML元素
    // 创建文本层SVG元素，用于显示标注文本
    this.text = window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    // 使用SVG.js库包装文本层，提供更方便的API
    this.adoptedText = SVG.adopt(this.text as any as HTMLElement) as SVG.Container;

    // 创建背景画布，用于显示图像
    this.background = window.document.createElement("canvas");

    // 创建遮罩内容画布，用于显示遮罩
    this.masksContent = window.document.createElement("canvas");

    // 创建内容层SVG元素，用于绘制矢量图形（标注、图形等）
    this.content = window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    // 使用SVG.js库包装内容层
    this.adoptedContent = SVG.adopt(this.content as any as HTMLElement) as SVG.Container;

    // 创建附加板div元素，用于显示附加信息
    this.attachmentBoard = window.document.createElement("div");

    // 创建主画布容器div元素，包含所有其他元素
    this.canvas = window.document.createElement("div");

    // 设置各元素的ID，便于样式和脚本引用
    this.text.setAttribute("id", "cvat_canvas_text_content");
    this.background.setAttribute("id", "cvat_canvas_background");
    this.masksContent.setAttribute("id", "cvat_canvas_masks_content");
    this.content.setAttribute("id", "cvat_canvas_content");

    // 设置附加板ID
    this.attachmentBoard.setAttribute("id", "cvat_canvas_attachment_board");

    // 设置主容器ID
    this.canvas.setAttribute("id", "cvat_canvas_wrapper");

    // 创建视频元素
    this.videoElement = window.document.createElement("video");
    this.videoElement.setAttribute("id", "cvat_canvas_video");

    this.videoElement.addEventListener("play", () => {
      this.isVideoPlaying = true;
    });
    this.videoElement.addEventListener("pause", () => {
      this.isVideoPlaying = false;
    });
    this.videoElement.addEventListener("ended", () => {
      this.isVideoPlaying = false;
    });

    // 将创建的HTML元素组织在一起

    // 按照正确的顺序将元素添加到主容器中
    // 这个顺序决定了渲染层次（从下到上）
    this.canvas.appendChild(this.text); // 文本层
    this.canvas.appendChild(this.background); // 背景图像层
    this.canvas.appendChild(this.videoElement); // 视频层
    this.canvas.appendChild(this.masksContent); // 遮罩层
    this.canvas.appendChild(this.content); // 内容层（矢量图形）
    this.canvas.appendChild(this.attachmentBoard); // 附加板层

    // 设置API处理器，负责处理各种用户交互和绘制操作
    this.autoborderHandler = new AutoborderHandlerImpl(this.content);

    this.drawHandler = new DrawHandlerImpl(
      this.onDrawDone,
      this.adoptedContent,
      this.adoptedText,
      this.autoborderHandler,
      this.geometry,
      this.configuration
    );

    this.masksHandler = new MasksHandlerImpl(
      this.onDrawDone,
      this.controller.draw.bind(this.controller),
      this.onEditStart,
      this.onEditDone,
      this.drawHandler,
      this.masksContent
    );

    this.editHandler = new EditHandlerImpl(
      this.onEditDone,
      this.adoptedContent,
      this.autoborderHandler
    );

    this.mergeHandler = new MergeHandlerImpl(
      this.onMergeDone,
      this.onFindObject,
      this.adoptedContent
    );

    this.splitHandler = new SplitHandlerImpl(
      this.onSplitDone,
      this.onFindObject,
      this.adoptedContent
    );

    this.objectSelector = new ObjectSelectorImpl(
      this.onFindObject,
      () => this.controller.objects,
      this.geometry,
      this.adoptedContent
    );

    this.groupHandler = new GroupHandlerImpl(this.onSelectDone, this.objectSelector);

    this.sliceHandler = new SliceHandlerImpl(
      (clientID) => this.setupInnerFlags(clientID, "sliceHidden", true),
      (clientID) => this.setupInnerFlags(clientID, "sliceHidden", false),
      this.onSliceDone,
      this.onMessage,
      this.onError,
      () => this.controller.objects,
      this.geometry,
      this.adoptedContent,
      this.objectSelector
    );

    this.regionSelector = new RegionSelectorImpl(
      this.onRegionSelected,
      this.adoptedContent,
      this.geometry
    );

    this.zoomHandler = new ZoomHandlerImpl(
      this.onFocusRegion,
      this.adoptedContent,
      this.geometry
    );

    this.interactionHandler = new InteractionHandlerImpl(
      this.onInteraction,
      this.adoptedContent,
      this.geometry,
      this.configuration
    );

    // 设置事件处理器
    // 双击事件：使图像适应画布大小
    this.canvas.addEventListener("dblclick", (e: MouseEvent): void => {
      this.controller.fit();
      e.preventDefault();
    });

    // 鼠标按下事件：启用拖动功能
    this.canvas.addEventListener("mousedown", (event): void => {
      if ([0, 1].includes(event.button)) {
        if (
          [Mode.IDLE, Mode.DRAG_CANVAS, Mode.MERGE, Mode.SPLIT].includes(this.mode) ||
          event.button === 1 ||
          event.altKey
        ) {
          this.controller.enableDrag(event.clientX, event.clientY);
        }
      }
    });

    // 全局鼠标释放事件
    window.document.addEventListener("mouseup", this.onMouseUp);
    // 全局键盘按下事件
    window.document.addEventListener("keydown", this.onKeyDown);
    // 全局键盘释放事件
    window.document.addEventListener("keyup", this.onKeyUp);

    // 为附加板添加事件监听器，阻止事件冒泡
    for (const eventName of ["wheel", "mousedown", "dblclick", "contextmenu"]) {
      this.attachmentBoard.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    }

    // 滚轮事件：处理缩放
    this.canvas.addEventListener("wheel", (event): void => {
      if (this.ctrlPressed) {
        // 不使用event.ctrlKey来正确处理触摸板的捏合缩放
        // 捏合缩放会自动生成'wheel'事件，event.ctrlKey为true
        // 即使实际上没有按下ctrl键
        return;
      }

      let { deltaY } = event;
      // 限制过大的值以避免过强的缩放
      // 较大的值通常适用于鼠标
      // 8是避免过强缩放的实验值
      const LIMIT_DELTA_Y = 8;
      deltaY = clamp(deltaY, -LIMIT_DELTA_Y, LIMIT_DELTA_Y);

      const { offset } = this.controller.geometry;
      const point = translateToSVG(this.content, [event.clientX, event.clientY]);
      this.controller.zoom(point[0] - offset, point[1] - offset, deltaY);
      // 派发自定义缩放事件
      this.canvas.dispatchEvent(
        new CustomEvent("canvas.zoom", {
          bubbles: false,
          cancelable: true,
        })
      );
      event.preventDefault();
    });

    // 鼠标移动事件：处理拖动和位置更新
    this.canvas.addEventListener("mousemove", (e): void => {
      this.controller.drag(e.clientX, e.clientY);

      if (this.mode !== Mode.IDLE) return;
      if (e.ctrlKey || e.altKey) return;

      if (!this.isImageLoading) {
        const { offset } = this.controller.geometry;
        const [x, y] = translateToSVG(this.content, [e.clientX, e.clientY]);
        // 派发自定义移动事件
        const event: CustomEvent = new CustomEvent("canvas.moved", {
          bubbles: false,
          cancelable: true,
          detail: {
            x: x - offset,
            y: y - offset,
            states: this.controller.objects,
          },
        });

        this.canvas.dispatchEvent(event);
      }
    });

    // 禁用内容层的右键菜单
    this.content.oncontextmenu = (): boolean => false;

    // 订阅模型变化，使当前视图成为模型的监听器
    model.subscribe(this);
  }
  //#endregion

  /**
   * 获取画布的HTML元素
   * @returns {HTMLDivElement} 画布的HTMLDivElement元素
   */
  public html(): HTMLDivElement {
    return this.canvas;
  }

  /**
   * 通知方法 - 处理来自模型的各种更新事件
   * 根据不同的更新原因执行相应的画布操作
   * @param model 画布模型实例，包含当前状态和配置
   * @param reason 更新原因，决定执行何种操作
   */
  public notify(model: CanvasModel & Master, reason: UpdateReasons): void {
    // 更新几何信息
    this.geometry = this.controller.geometry;

    // 处理配置更新事件
    if (reason === UpdateReasons.CONFIG_UPDATED) {
      // 保存当前激活元素
      const { activeElement } = this;
      // 临时停用当前激活状态
      this.deactivate();
      // 获取新的配置
      const { configuration } = model;

      // 更新图形视图的内部函数
      const updateShapeViews = (states: DrawnState[], parentState?: DrawnState): void => {
        for (const drawnState of states) {
          // 获取图形的颜色配置（填充色、边框色、透明度）
          const {
            fill,
            stroke,
            "fill-opacity": fillOpacity,
          } = this.getShapeColorization(drawnState, { parentState });
          // 查找对应的图形视图元素
          const shapeView = window.document.getElementById(
            `cvat_canvas_shape_${drawnState.clientID}`
          );
          // 获取对象状态
          const [objectState] = this.controller.objects.filter(
            (_state: any) => _state.clientID === drawnState.clientID
          );
          if (shapeView) {
            // 获取选择处理器
            const handler = (shapeView as any).instance.remember("_selectHandler");
            // 更新嵌套元素的填充色
            if (handler && handler.nested) {
              handler.nested.fill({ color: fill });
            }

            // 如果是掩码类型，需要重新绘制
            if (drawnState.shapeType === "mask") {
              // 删除旧掩码并添加新掩码
              this.deleteObjects([drawnState]);
              this.addObjects([objectState]);
              continue;
            }

            // 更新图形的填充色和边框色
            (shapeView as any).instance
              .fill({ color: fill, opacity: fillOpacity })
              .stroke({ color: stroke });
          }

          // 递归处理子元素
          if (drawnState.elements) {
            updateShapeViews(drawnState.elements, drawnState);
          }
        }
      };

      // 检查是否需要更新图形视图
      const withUpdatingShapeViews =
        configuration.shapeOpacity !== this.configuration.shapeOpacity ||
        configuration.selectedShapeOpacity !== this.configuration.selectedShapeOpacity ||
        configuration.outlinedBorders !== this.configuration.outlinedBorders ||
        configuration.colorBy !== this.configuration.colorBy ||
        configuration.showConflicts !== this.configuration.showConflicts;

      // 处理显示所有文本的配置变化
      if (configuration.displayAllText && !this.configuration.displayAllText) {
        // 如果新配置启用显示所有文本，为每个对象添加文本
        for (const i in this.drawnStates) {
          if (!(i in this.svgTexts)) {
            this.svgTexts[i] = this.addText(this.drawnStates[i]);
          }
        }
      } else if (
        configuration.displayAllText === false &&
        this.configuration.displayAllText
      ) {
        // 如果新配置禁用显示所有文本，删除非激活对象的文本
        for (const clientID in this.drawnStates) {
          if (+clientID !== activeElement.clientID) {
            this.deleteText(+clientID);
          }
        }
      }

      // 检查是否需要重新创建文本
      const recreateText = configuration.textContent !== this.configuration.textContent;
      // 检查是否需要更新文本位置
      const updateTextPosition =
        configuration.displayAllText !== this.configuration.displayAllText ||
        configuration.textFontSize !== this.configuration.textFontSize ||
        configuration.textPosition !== this.configuration.textPosition ||
        recreateText;

      // 处理图像平滑显示配置
      if (configuration.smoothImage === true) {
        // 启用图像平滑
        this.background.classList.remove("cvat_canvas_pixelized");
      } else if (configuration.smoothImage === false) {
        // 禁用图像平滑（像素化显示）
        this.background.classList.add("cvat_canvas_pixelized");
      }

      // 更新当前配置
      this.configuration = configuration;
      // 如果需要，更新所有图形视图
      if (withUpdatingShapeViews) {
        updateShapeViews(Object.values(this.drawnStates));
      }

      // 如果需要重新创建文本
      if (recreateText) {
        const states = this.controller.objects;
        for (const key of Object.keys(this.drawnStates)) {
          const clientID = +key;
          // 查找对应的状态
          const [state] = states.filter((_state: any) => _state.clientID === clientID);
          if (clientID in this.svgTexts) {
            // 删除旧文本
            this.deleteText(+clientID);
            // 如果状态存在，添加新文本
            if (state) {
              this.addText(state);
            }
          }
        }
      }

      // 如果需要更新文本位置
      if (updateTextPosition) {
        for (const i in this.drawnStates) {
          if (i in this.svgTexts) {
            // 更新每个文本的位置
            this.updateTextPosition(this.svgTexts[i]);
          }
        }
      }

      // 应用CSS图像滤镜
      if (typeof configuration.CSSImageFilter === "string") {
        this.background.style.filter = configuration.CSSImageFilter;
      }

      // 重新激活之前的活动元素
      this.activate(activeElement);
      // 配置各种处理器
      this.editHandler.configure(this.configuration);
      this.drawHandler.configure(this.configuration);
      this.masksHandler.configure(this.configuration);
      this.autoborderHandler.configure(this.configuration);
      this.interactionHandler.configure(this.configuration);
      this.sliceHandler.configure(this.configuration);
      // 重新变换画布
      this.transformCanvas();

      // 标注掉的代码：如果需要，可以重新设置对象
      // this.setupObjects([]);
      // this.setupObjects(model.objects);
    }
    // 处理图像更改事件
    if (reason === UpdateReasons.IMAGE_CHANGED) {
      const { configuration, media } = model;
      if (media) {
        // 图像加载完成
        this.isImageLoading = false;

        if (media.mediaType === "image" && media.imageData) {
          // 切换到图像模式
          this.switchToImageMode();
          // 获取画布上下文
          const ctx = this.background.getContext("2d");
          // 设置画布尺寸
          this.background.setAttribute("width", `${media.renderWidth}px`);
          this.background.setAttribute("height", `${media.renderHeight}px`);

          // 绘制图像
          if (ctx) {
            ctx.drawImage(media.imageData, 0, 0, media.renderWidth, media.renderHeight);
          }
        } else if (media.mediaType === "video" && media.videoUrl) {
          // 视频播放配置
          this.videoElement.autoplay = configuration.videoAutoPlay ?? false;
          this.videoElement.loop = configuration.videoLoop ?? false;
          // 设置视频源
          this.videoElement.src = media.videoUrl;
          this.videoElement.load();
          // 重置视频状态
          this.isVideoPlaying = this.videoElement.autoplay;
          // 设置视频元素尺寸
          this.videoElement.style.width = `${media.renderWidth}px`;
          this.videoElement.style.height = `${media.renderHeight}px`;
          // 显示视频元素，隐藏背景画布
          this.videoElement.style.display = "block";
          this.background.style.display = "none";
        }
        // 更新画布位置、大小和变换
        this.moveCanvas();
        this.resizeCanvas();
        this.transformCanvas();
      } else {
        // 图像正在加载
        this.isImageLoading = true;
      }
    }
    // 处理画布适配事件
    else if (reason === UpdateReasons.FITTED_CANVAS) {
      // 画布几何图形将要改变，旧的对象位置不再有效
      this.setupObjects([]);
      // 更新画布位置和大小
      this.moveCanvas();
      this.resizeCanvas();
      // 分发画布重塑事件
      this.canvas.dispatchEvent(
        new CustomEvent("canvas.reshape", {
          bubbles: false,
          cancelable: true,
        })
      );
    }
    // 处理图像缩放和适配事件
    else if ([UpdateReasons.IMAGE_ZOOMED, UpdateReasons.IMAGE_FITTED].includes(reason)) {
      if (reason === UpdateReasons.IMAGE_FITTED) {
        // 分发画布适配事件
        this.canvas.dispatchEvent(
          new CustomEvent("canvas.fit", {
            bubbles: false,
            cancelable: true,
          })
        );
      }

      // 更新画布位置和变换
      this.moveCanvas();
      this.transformCanvas();
    }
    // 处理图像旋转事件
    else if (reason === UpdateReasons.IMAGE_ROTATED) {
      // 更新画布变换
      this.transformCanvas();
    }
    // 处理图像移动事件
    else if (reason === UpdateReasons.IMAGE_MOVED) {
      // 更新画布位置
      this.moveCanvas();
    }
    // 处理对象更新事件
    else if (reason === UpdateReasons.OBJECTS_UPDATED) {
      // 重置选择器
      this.objectSelector.resetSelected();
      // 设置新对象
      this.setupObjects(this.controller.objects);
      // 如果处于合并模式，重复选择
      if (this.mode === Mode.MERGE) {
        this.mergeHandler.repeatSelection();
      }
      // 分发画布设置事件
      const event: CustomEvent = new CustomEvent("canvas.setup");
      this.canvas.dispatchEvent(event);
    }
    // 处理图形聚焦事件
    else if (reason === UpdateReasons.SHAPE_FOCUSED) {
      // 获取聚焦数据
      const { padding, clientID } = this.controller.focusData;
      // 获取绘制状态和对象
      const drawnState = this.drawnStates[clientID];
      const object = this.svgShapes[clientID];
      if (drawnState && object) {
        // 获取偏移量
        const { offset } = this.geometry;
        let [x, y, width, height] = [0, 0, 0, 0];

        // 处理掩码类型的特殊逻辑
        if (drawnState.shapeType === "mask") {
          // 获取掩码边界点
          const [xtl, ytl, xbr, ybr] = drawnState.points!.slice(-4);
          x = xtl + offset;
          y = ytl + offset;
          width = xbr - xtl + 1;
          height = ybr - ytl + 1;
        } else {
          // 获取其他图形的边界框
          const bbox: SVG.BBox = object.bbox();
          ({ x, y, width, height } = bbox);
        }

        // 聚焦到指定区域（添加填充）
        this.onFocusRegion(
          x - padding,
          y - padding,
          width + padding * 2,
          height + padding * 2
        );
      }
    }
    // 处理图形激活事件
    else if (reason === UpdateReasons.SHAPE_ACTIVATED) {
      // 激活指定元素
      this.activate(this.controller.activeElement);
    }
    // 处理图形高亮事件
    else if (reason === UpdateReasons.SHAPE_HIGHLIGHTED) {
      // 高亮指定元素
      this.highlight(this.controller.highlightedElements);
    }
    // 处理区域选择模式事件
    else if (reason === UpdateReasons.SELECT_REGION) {
      if (this.mode === Mode.SELECT_REGION) {
        // 启用区域选择
        this.regionSelector.select(true);
        // 设置光标为指针
        this.canvas.style.cursor = "pointer";
      } else {
        // 禁用区域选择
        this.regionSelector.select(false);
        // 恢复默认光标
        this.canvas.style.cursor = "";
      }
    }
    // 处理画布拖拽模式事件
    else if (reason === UpdateReasons.DRAG_CANVAS) {
      if (this.mode === Mode.DRAG_CANVAS) {
        // 分发拖拽开始事件
        this.canvas.dispatchEvent(
          new CustomEvent("canvas.dragstart", {
            bubbles: false,
            cancelable: true,
          })
        );
        // 设置光标为移动
        this.canvas.style.cursor = "move";
      } else {
        // 分发拖拽停止事件
        this.canvas.dispatchEvent(
          new CustomEvent("canvas.dragstop", {
            bubbles: false,
            cancelable: true,
          })
        );
        // 恢复默认光标
        this.canvas.style.cursor = "";
      }
    }
    // 处理画布缩放模式事件
    else if (reason === UpdateReasons.ZOOM_CANVAS) {
      if (this.mode === Mode.ZOOM_CANVAS) {
        // 分发缩放开始事件
        this.canvas.dispatchEvent(
          new CustomEvent("canvas.zoomstart", {
            bubbles: false,
            cancelable: true,
          })
        );
        // 设置光标为放大
        this.canvas.style.cursor = "zoom-in";
        // 开始缩放操作
        this.zoomHandler.zoom();
      } else {
        // 分发缩放停止事件
        this.canvas.dispatchEvent(
          new CustomEvent("canvas.zoomstop", {
            bubbles: false,
            cancelable: true,
          })
        );
        // 恢复默认光标
        this.canvas.style.cursor = "";
        // 取消缩放操作
        this.zoomHandler.cancel();
      }
    }
    // 处理绘制模式事件
    else if (reason === UpdateReasons.DRAW) {
      // 获取绘制数据
      const data: DrawData = this.controller.drawData;
      if (data.enabled && [Mode.IDLE, Mode.DRAW].includes(this.mode)) {
        // 根据图形类型选择不同的处理器
        if (data.shapeType !== "mask") {
          // 使用常规绘制处理器
          this.drawHandler.draw(data, this.geometry);
        } else {
          // 使用掩码处理器
          this.masksHandler.draw(data);
        }

        // 如果当前是空闲模式，切换到绘制模式
        if (this.mode === Mode.IDLE) {
          // 设置光标为十字准线
          this.canvas.style.cursor = "crosshair";
          // 切换到绘制模式
          this.mode = Mode.DRAW;
          // 分发绘制开始事件
          this.canvas.dispatchEvent(
            new CustomEvent("canvas.drawstart", {
              bubbles: false,
              cancelable: true,
              detail: {
                drawData: data,
              },
            })
          );

          // 如果需要重绘，设置内部标志
          if (typeof data.redraw === "number") {
            this.setupInnerFlags(data.redraw, "drawHidden", true);
          }
        }
      }
      // 如果不是空闲模式，取消绘制
      else if (this.mode !== Mode.IDLE) {
        // 恢复默认光标
        this.canvas.style.cursor = "";
        // 切换到空闲模式
        this.mode = Mode.IDLE;
        // 根据处理器类型执行绘制
        if (this.masksHandler.enabled) {
          this.masksHandler.draw(data);
        } else {
          this.drawHandler.draw(data, this.geometry);
        }
      }
    }
    // 处理编辑模式事件
    else if (reason === UpdateReasons.EDIT) {
      // 获取编辑数据
      const data = this.controller.editData;
      // 根据图形类型选择不同的处理器
      if (data.enabled && data.state.shapeType === "mask") {
        // 掩码编辑
        this.masksHandler.edit(data);
      } else if (this.masksHandler.enabled) {
        // 掩码处理器启用时的编辑
        this.masksHandler.edit(data);
      } else if (this.editHandler.enabled && this.editHandler.shapeType === "polyline") {
        // 折线编辑
        this.editHandler.edit(data);
      }
    }
    // 处理交互模式事件
    else if (reason === UpdateReasons.INTERACT) {
      // 获取交互数据
      const data: InteractionData = this.controller.interactionData;
      if (data.enabled && (this.mode === Mode.IDLE || data.intermediateShape)) {
        // 如果是空闲模式或中间图形
        if (!data.intermediateShape) {
          // 设置光标为十字准线
          this.canvas.style.cursor = "crosshair";
          // 切换到交互模式
          this.mode = Mode.INTERACT;
        }
        // 执行交互操作
        this.interactionHandler.interact(data);
      } else {
        // 如果交互未启用，恢复默认光标
        if (!data.enabled) {
          this.canvas.style.cursor = "";
        }
        // 如果不是空闲模式，执行交互操作
        if (this.mode !== Mode.IDLE) {
          this.interactionHandler.interact(data);
        }
      }
    }
    // 处理合并模式事件
    else if (reason === UpdateReasons.MERGE) {
      // 获取合并数据
      const data: MergeData = this.controller.mergeData;
      if (data.enabled) {
        // 设置光标为复制
        this.canvas.style.cursor = "copy";
        // 切换到合并模式
        this.mode = Mode.MERGE;
      }
      // 执行合并操作
      this.mergeHandler.merge(data);
    }
    // 处理分割模式事件
    else if (reason === UpdateReasons.SPLIT) {
      // 获取分割数据
      const data: SplitData = this.controller.splitData;
      if (data.enabled) {
        // 设置光标为复制
        this.canvas.style.cursor = "copy";
        // 切换到分割模式
        this.mode = Mode.SPLIT;
        // 执行分割操作
        this.splitHandler.split(data);
      }
    }
    // 处理连接和分组模式事件
    else if ([UpdateReasons.JOIN, UpdateReasons.GROUP].includes(reason)) {
      let data: GroupData | JoinData;
      if (reason === UpdateReasons.GROUP) {
        // 分组模式
        data = this.controller.groupData;
        // 切换到分组模式
        this.mode = Mode.GROUP;
        // 执行分组操作
        this.groupHandler.group(data, {});
      } else {
        // 连接模式
        data = this.controller.joinData;
        // 切换到连接模式
        this.mode = Mode.JOIN;

        // 显示连接提示信息
        this.onMessage(
          [
            {
              type: "text",
              icon: "info",
              content:
                "Click masks you would like to join together. To unselect click selected mask one more time",
            },
          ],
          "join"
        );

        // 执行连接操作，限制为掩码类型的图形
        this.groupHandler.group(data, {
          shapeType: ["mask"],
          objectType: ["shape"],
        });
      }
    }
    // 处理切片模式事件
    else if (reason === UpdateReasons.SLICE) {
      // 获取切片数据
      const data = this.controller.sliceData;
      if (data.enabled && this.mode === Mode.IDLE) {
        // 切换到切片模式
        this.mode = Mode.SLICE;
        // 执行切片操作
        this.sliceHandler.slice(data);
      }
    }
    // 处理选择事件
    else if (reason === UpdateReasons.SELECT) {
      // 推送选中的对象
      this.objectSelector.push(this.controller.selected);
      // 如果处于合并模式，更新合并选择
      if (this.mode === Mode.MERGE) {
        this.mergeHandler.select(this.controller.selected);
      }
      // 如果处于分割模式，更新分割选择
      else if (this.mode === Mode.SPLIT) {
        this.splitHandler.select(this.controller.selected);
      }
    }
    // 处理取消事件
    else if (reason === UpdateReasons.CANCEL) {
      // 根据当前模式执行相应的取消操作
      if (this.mode === Mode.DRAW) {
        // 取消绘制
        if (this.masksHandler.enabled) {
          this.masksHandler.cancel();
        } else {
          this.drawHandler.cancel();
        }
      } else if (this.mode === Mode.INTERACT) {
        // 取消交互
        this.interactionHandler.cancel();
      } else if (this.mode === Mode.MERGE) {
        // 取消合并
        this.mergeHandler.cancel();
      } else if (this.mode === Mode.SPLIT) {
        // 取消分割
        this.splitHandler.cancel();
      } else if (this.mode === Mode.GROUP || this.mode === Mode.JOIN) {
        // 取消分组或连接
        this.groupHandler.cancel();
      } else if (this.mode === Mode.SLICE) {
        // 取消切片
        this.sliceHandler.cancel();
      } else if (this.mode === Mode.SELECT_REGION) {
        // 取消区域选择
        this.regionSelector.cancel();
      } else if (this.mode === Mode.EDIT) {
        // 取消编辑
        if (this.masksHandler.enabled) {
          this.masksHandler.cancel();
        } else {
          this.editHandler.cancel();
        }
      } else if (this.mode === Mode.DRAG_CANVAS) {
        // 分发拖拽停止事件
        this.canvas.dispatchEvent(
          new CustomEvent("canvas.dragstop", {
            bubbles: false,
            cancelable: true,
          })
        );
      } else if (this.mode === Mode.ZOOM_CANVAS) {
        // 取消缩放
        this.zoomHandler.cancel();
        // 分发缩放停止事件
        this.canvas.dispatchEvent(
          new CustomEvent("canvas.zoomstop", {
            bubbles: false,
            cancelable: true,
          })
        );
      }
      // 恢复默认光标
      this.canvas.style.cursor = "";
      // 分发取消事件
      this.dispatchCanceledEvent();
    }
    // 处理数据获取失败事件
    else if (reason === UpdateReasons.DATA_FAILED) {
      // 处理错误
      this.onError(model.exception, "data fetching");
    }
    // 处理销毁事件
    else if (reason === UpdateReasons.DESTROY) {
      // 分发销毁事件
      this.canvas.dispatchEvent(
        new CustomEvent("canvas.destroy", {
          bubbles: false,
          cancelable: true,
        })
      );

      // 移除事件监听器
      window.document.removeEventListener("keydown", this.onKeyDown);
      window.document.removeEventListener("keyup", this.onKeyUp);
      window.document.removeEventListener("mouseup", this.onMouseUp);
      // 销毁交互处理器
      this.interactionHandler.destroy();
    }
  }

  /**
   * 鼠标释放事件处理方法
   * 处理鼠标释放事件，禁用拖拽功能
   * @param event - 鼠标事件对象
   */
  private onMouseUp = (event: MouseEvent): void => {
    // 只处理左键和中间键释放
    if (event.button === 0 || event.button === 1) {
      this.controller.disableDrag();
    }
  };

  /**
   * 键盘按下事件处理方法
   * 处理键盘按下事件，支持Shift和Ctrl键的特殊功能
   * @param e - 键盘事件对象
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    // 忽略重复按键事件
    if (e.repeat) {
      return;
    }

    const code = (e.code ?? "").toLowerCase();

    // Shift键按下：启用角度捕捉
    if (code.includes("shift")) {
      this.snapToAngleResize = consts.SNAP_TO_ANGLE_RESIZE_SHIFT;
      if (this.activeElement) {
        const shape = this.svgShapes[this.activeElement.clientID!];
        if (shape && shape?.remember("_selectHandler")?.options?.rotationPoint) {
          // 骨架类型特殊处理
          if (this.drawnStates[this.activeElement.clientID!]?.shapeType === "skeleton") {
            const wrappingRect = (shape as any)
              .children()
              .find((child: SVG.Element) => child.type === "rect");
            if (wrappingRect) {
              (wrappingRect as any).resize({ snapToAngle: this.snapToAngleResize });
            }
          } else {
            (shape as any).resize({ snapToAngle: this.snapToAngleResize });
          }
        }
      }
    }

    // Ctrl键按下：标记Ctrl键状态
    if (code.includes("control")) {
      this.ctrlPressed = true;
    }
  };

  /**
   * 键盘释放事件处理方法
   * 处理键盘释放事件，恢复Shift和Ctrl键的默认状态
   * @param e - 键盘事件对象
   */
  private onKeyUp = (e: KeyboardEvent): void => {
    const code = (e.code ?? "").toLowerCase();

    // Shift键释放：恢复默认角度捕捉
    if (code.includes("shift") && this.activeElement) {
      this.snapToAngleResize = consts.SNAP_TO_ANGLE_RESIZE_DEFAULT;
      if (this.activeElement) {
        const shape = this.svgShapes[this.activeElement.clientID!];
        if (shape && shape?.remember("_selectHandler")?.options?.rotationPoint) {
          // 骨架类型特殊处理
          if (this.drawnStates[this.activeElement.clientID!]?.shapeType === "skeleton") {
            const wrappingRect = (shape as any)
              .children()
              .find((child: SVG.Element) => child.type === "rect");
            if (wrappingRect) {
              (wrappingRect as any).resize({ snapToAngle: this.snapToAngleResize });
            }
          } else {
            (shape as any).resize({ snapToAngle: this.snapToAngleResize });
          }
        }
      }
    }

    // Ctrl键释放：重置Ctrl键状态
    if (code.includes("control")) {
      this.ctrlPressed = false;
    }
  };

  /**
   * 处理交互事件
   * 处理图形交互结果并分发相应事件
   * @param shapes - 交互结果数组或null
   * @param shapesUpdated - 图形是否已更新
   * @param isDone - 交互是否完成
   */
  private onInteraction = (
    shapes: InteractionResult[] | null,
    shapesUpdated = true,
    isDone = false
  ): void => {
    const { zLayer } = this.controller;
    if (Array.isArray(shapes)) {
      // 如果有交互结果，创建并分发canvas.interacted事件
      const event: CustomEvent = new CustomEvent("canvas.interacted", {
        bubbles: false,
        cancelable: true,
        detail: {
          shapesUpdated,
          isDone,
          shapes,
          zOrder: zLayer || 0,
        },
      });

      this.canvas.dispatchEvent(event);
    }

    // 如果没有交互结果或交互已完成，分发取消事件
    if (shapes === null || isDone) {
      this.dispatchCanceledEvent();
    }
  };

  /**
   * 区域选择完成事件处理方法
   * 当区域选择操作完成时被调用，处理选定的区域点
   * @param points - 选定区域的点坐标数组，格式为[x1, y1, x2, y2, ...]
   */
  private onRegionSelected = (points?: number[]): void => {
    if (points) {
      // 分发区域选择完成事件，包含选定的点坐标
      this.canvas.dispatchEvent(
        new CustomEvent("canvas.regionselected", {
          bubbles: false,
          cancelable: true,
          detail: {
            points,
          },
        })
      );
    } else {
      // 如果操作被取消，分发取消事件
      this.dispatchCanceledEvent();
    }
  };

  /**
   * 切片操作完成事件处理方法
   * 当切片操作完成时被调用，处理切片结果并分发相应事件
   * @param state - 切片操作后的状态数据
   * @param results - 切片结果数组，包含每个切片的点坐标
   * @param duration - 切片操作持续时间（毫秒）
   */
  private onSliceDone = (state?: any, results?: number[][], duration?: number): void => {
    if (state && results && typeof duration !== "undefined") {
      // 设置画布为空闲模式
      this.mode = Mode.IDLE;
      // 禁用切片处理器
      this.sliceHandler.slice({ enabled: false });
      // 分发切片完成事件，包含状态、结果和持续时间
      this.canvas.dispatchEvent(
        new CustomEvent("canvas.sliced", {
          bubbles: false,
          cancelable: true,
          detail: {
            state,
            results,
            duration,
          },
        })
      );
    } else {
      // 如果操作被取消，分发取消事件
      this.dispatchCanceledEvent();
    }
  };

  /**
   * 处理画布消息事件
   * 将消息转换为自定义事件并分发到画布元素
   * @param messages - 消息数组或null
   * @param topic - 消息主题
   */
  private onMessage = (messages: CanvasHint[] | null, topic: string): void => {
    // 创建并分发canvas.message自定义事件
    this.canvas.dispatchEvent(
      new CustomEvent("canvas.message", {
        bubbles: false,
        cancelable: true,
        detail: {
          topic,
          messages,
        },
      })
    );
  };

  /**
   * 处理选择完成事件
   * 根据当前模式处理不同的选择结果：分组或连接对象
   * @param objects - 选中的对象数组（可选）
   * @param duration - 选择操作持续时间
   */
  private onSelectDone = (objects?: any[], duration?: number): void => {
    // 如果是连接模式，清空消息
    if (this.mode === Mode.JOIN) {
      this.onMessage(null, "join");
    }

    if (objects && typeof duration !== "undefined") {
      // 如果是分组模式且选中多个对象
      if (this.mode === Mode.GROUP && objects.length > 1) {
        this.mode = Mode.IDLE;
        // 分发canvas.grouped事件
        this.canvas.dispatchEvent(
          new CustomEvent("canvas.grouped", {
            bubbles: false,
            cancelable: true,
            detail: {
              duration,
              states: objects,
            },
          })
        );
      } else if (this.mode === Mode.JOIN && objects.length > 1) {
        // 如果是连接模式且选中多个对象
        this.mode = Mode.IDLE;
        // 计算所有对象的边界框
        let [left, top, right, bottom] = objects[0].points.slice(-4);
        objects.forEach((state) => {
          const [curLeft, curTop, curRight, curBottom] = state.points.slice(-4);
          left = Math.min(left, curLeft);
          top = Math.min(top, curTop);
          right = Math.max(right, curRight);
          bottom = Math.max(bottom, curBottom);
        });

        // 为每个对象创建图像位图
        Promise.all(
          objects.map((state) => {
            const [curLeft, , curRight] = state.points.slice(-4, -1);
            const image = new ImageData(
              new Uint8ClampedArray(expandChannels(255, 255, 255, state.points)),
              curRight - curLeft + 1
            );
            return createImageBitmap(image);
          })
        )
          .then((results) => {
            // 创建离屏画布并绘制所有位图
            const canvas = new OffscreenCanvas(right - left + 1, bottom - top + 1);
            results.forEach((bitmap, idx) => {
              const [curLeft, curTop] = objects[idx].points.slice(-4, -2);
              canvas.getContext("2d")!.drawImage(bitmap, curLeft - left, curTop - top);
              bitmap.close();
            });

            // 获取图像数据并压缩通道
            const imageData = canvas
              .getContext("2d")!
              .getImageData(0, 0, right - left + 1, bottom - top + 1);
            const rle = zipChannels(imageData.data);
            // 添加边界坐标
            rle.push(left, top, right, bottom);

            // 分发canvas.joined事件
            this.canvas.dispatchEvent(
              new CustomEvent("canvas.joined", {
                bubbles: false,
                cancelable: true,
                detail: {
                  duration,
                  states: objects,
                  points: rle,
                },
              })
            );
          })
          .catch(this.onError);
      }
    } else {
      this.dispatchCanceledEvent();
    }
  };

  /**
   * 处理画布错误事件
   * 将错误转换为自定义事件并分发到画布元素
   * @param exception - 异常对象
   * @param domain - 错误域（可选）
   */
  private onError = (exception: unknown, domain?: string): void => {
    // 创建并分发canvas.error自定义事件
    this.canvas.dispatchEvent(
      new CustomEvent("canvas.error", {
        bubbles: false,
        cancelable: true,
        detail: {
          domain,
          // 确保异常对象是Error类型，如果不是则创建新的Error对象
          exception:
            exception instanceof Error
              ? exception
              : new Error(`Unknown exception: "${exception}"`),
        },
      })
    );
  };

  /**
   * 处理分割完成事件
   * 设置画布为空闲模式，禁用分割处理，分发分割完成事件
   * @param object - 分割后的对象（可选）
   * @param duration - 分割操作持续时间
   */
  private onSplitDone = (object?: any, duration?: number): void => {
    if (object && typeof duration !== "undefined") {
      // 创建并分发canvas.splitted事件
      const event: CustomEvent = new CustomEvent("canvas.splitted", {
        bubbles: false,
        cancelable: true,
        detail: {
          duration,
          state: object,
          frame: object.frame,
        },
      });

      // 重置光标和模式
      this.canvas.style.cursor = "";
      this.mode = Mode.IDLE;
      // 禁用分割处理
      this.splitHandler.split({ enabled: false });
      this.canvas.dispatchEvent(event);
    } else {
      this.dispatchCanceledEvent();
    }
  };

  /**
   * 查找对象事件处理方法
   * 当用户点击画布时被调用，查找点击位置的对象并分发查找事件
   * @param e - 鼠标事件对象
   */
  private onFindObject = (e: MouseEvent): void => {
    // 只处理左键点击
    if (e.button === 0) {
      // 获取画布几何偏移量
      const { offset } = this.controller.geometry;
      // 将鼠标坐标转换为SVG坐标
      const [x, y] = translateToSVG(this.content, [e.clientX, e.clientY]);
      // 创建查找事件，包含点击位置和所有对象状态
      const event: CustomEvent = new CustomEvent("canvas.find", {
        bubbles: false,
        cancelable: true,
        detail: {
          x: x - offset,
          y: y - offset,
          states: this.controller.objects,
        },
      });

      // 分发查找事件
      this.canvas.dispatchEvent(event);
      // 阻止默认行为
      e.preventDefault();
    }
  };

  /**
   * 处理合并完成事件
   * 设置画布为空闲模式，分发合并完成事件
   * @param objects - 合并后的对象数组或null
   * @param duration - 合并操作持续时间
   */
  private onMergeDone = (objects: any[] | null, duration?: number): void => {
    if (objects) {
      // 创建并分发canvas.merged事件
      const event: CustomEvent = new CustomEvent("canvas.merged", {
        bubbles: false,
        cancelable: true,
        detail: {
          duration,
          states: objects,
        },
      });

      // 设置画布模式为空闲
      this.mode = Mode.IDLE;
      this.canvas.dispatchEvent(event);
    } else {
      this.dispatchCanceledEvent();
    }
  };

  /**
   * 处理绘制完成事件
   * 处理图形绘制完成后的逻辑，包括恢复隐藏对象、分发相应事件等
   * @param data - 绘制数据或null
   * @param duration - 绘制持续时间
   * @param continueDraw - 是否继续绘制
   * @param prevDrawData - 之前的绘制数据
   */
  private onDrawDone = (
    data: any | null,
    duration?: number,
    continueDraw?: boolean,
    prevDrawData?: DrawData
  ): void => {
    // 获取因绘制而隐藏的对象ID列表
    const hiddenBecauseOfDraw = Object.keys(this.innerObjectsFlags.drawHidden).map(
      (_clientID): number => +_clientID
    );
    // 恢复所有因绘制而隐藏的对象
    if (hiddenBecauseOfDraw.length) {
      for (const hidden of hiddenBecauseOfDraw) {
        this.setupInnerFlags(hidden, "drawHidden", false);
      }
    }

    if (data) {
      const { clientID, elements } = data as any;
      // 获取点坐标，优先使用data.points，否则从元素中提取
      const points = data.points || elements.flatMap((el: any) => el.points);

      // 如果有clientID，表示这是编辑现有对象
      if (typeof clientID === "number") {
        const [state] = this.controller.objects.filter(
          (_state: any): boolean => _state.clientID === clientID
        );
        // 调用编辑完成处理方法
        this.onEditDone(state, points);
        this.dispatchCanceledEvent();
        return;
      }

      // 获取当前z层级
      const { zLayer } = this.controller;
      // 创建并分发canvas.drawn事件
      const event: CustomEvent = new CustomEvent("canvas.drawn", {
        bubbles: false,
        cancelable: true,
        detail: {
          state: {
            ...data,
            zOrder: zLayer || 0,
          },
          continue: continueDraw,
          duration,
        },
      });

      this.canvas.dispatchEvent(event);
    } else if (!continueDraw) {
      // 如果没有数据且不继续绘制，分发取消事件
      this.dispatchCanceledEvent();
    }

    if (continueDraw) {
      // 如果继续绘制，分发绘制开始事件
      this.canvas.dispatchEvent(
        new CustomEvent("canvas.drawstart", {
          bubbles: false,
          cancelable: true,
          detail: {
            drawData: prevDrawData,
          },
        })
      );
    } else {
      // 当绘制从画布内部停止时（例如使用预定义的点数）
      this.mode = Mode.IDLE;
      this.canvas.style.cursor = "";
    }
  };

  /**
   * 分发取消事件
   * 将画布模式设置为空闲并分发取消事件
   */
  private dispatchCanceledEvent(): void {
    // 设置画布模式为空闲
    this.mode = Mode.IDLE;
    // 创建并分发canvas.canceled自定义事件
    const event: CustomEvent = new CustomEvent("canvas.canceled", {
      bubbles: false,
      cancelable: true,
    });

    this.canvas.dispatchEvent(event);
  }

  /**
   * 设置内部标志
   * 设置对象的内部隐藏标志并更新相应的SVG元素显示状态
   * @param clientID - 元素ID
   * @param path - 内部标志路径
   * @param value - 标志值
   */
  private setupInnerFlags(
    clientID: number,
    path: keyof CanvasViewImpl["innerObjectsFlags"],
    value: boolean
  ): void {
    // 设置内部标志
    this.innerObjectsFlags[path][clientID] = value;
    const shape = this.svgShapes[clientID];
    const text = this.svgTexts[clientID];
    const state = this.drawnStates[clientID];

    // 如果设置隐藏标志且该对象是当前激活元素，则取消激活
    if (value && clientID === this.controller.activeElement.clientID) {
      this.deactivate();
    }

    if (value) {
      // 如果标志值为true，隐藏图形和文本
      if (shape) {
        (state.shapeType === "points"
          ? shape.remember("_selectHandler").nested
          : shape
        ).addClass("cvat_canvas_hidden");
      }

      if (text) {
        text.addClass("cvat_canvas_hidden");
      }
    } else {
      // 如果标志值为false，删除标志并显示图形和文本
      delete this.innerObjectsFlags[path][clientID];

      if (state) {
        if (!state.outside && !state.hidden) {
          if (shape) {
            (state.shapeType === "points"
              ? shape.remember("_selectHandler").nested
              : shape
            ).removeClass("cvat_canvas_hidden");
          }

          if (text) {
            text.removeClass("cvat_canvas_hidden");
            this.updateTextPosition(text);
          }
        }
      }
    }
  }

  /**
   * 更新文本位置
   * 在对应的图形被移动、调整大小等操作后更新文本位置
   * @param {SVG.Text} text - 要更新位置的文本元素
   * @param {Object} options - 可选参数，包含旋转角度和中心点
   * @param {number} options.rotation.angle - 旋转角度
   * @param {number} options.rotation.cx - 旋转中心X坐标
   * @param {number} options.rotation.cy - 旋转中心Y坐标
   */
  private updateTextPosition(
    text: SVG.Text,
    options: { rotation?: { angle: number; cx: number; cy: number } } = {}
  ): void {
    // 获取元素ID
    const clientID = text.attr("data-client-id");
    if (!Number.isInteger(clientID)) return;
    // 获取对应的图形
    const shape = this.svgShapes[clientID];
    if (!shape) return;

    // 如果文本不可见，不进行位置更新（错误的变换矩阵）
    if (text.node.style.display === "none") return;

    // 获取文本配置
    const { textFontSize } = this.configuration;
    let { textPosition } = this.configuration;
    // 骨架元素强制使用自动位置
    if (shape.type === "circle") {
      textPosition = "auto";
    }

    // 重置文本变换并设置字体大小
    text.untransform();
    text.style({ "font-size": `${textFontSize}px` });
    // 获取旋转角度
    const rotation = options.rotation?.angle || getRoundedRotation(shape);

    // 找到文本的最佳位置
    let [clientX, clientY, clientCX, clientCY]: number[] = [0, 0, 0, 0];
    if (textPosition === "center") {
      // 居中位置
      let cx = 0;
      let cy = 0;
      if (["rect", "image"].includes(shape.type)) {
        // 矩形/遮罩的中心计算简单
        cx = +shape.attr("x") + +shape.attr("width") / 2;
        cy = +shape.attr("y") + +shape.attr("height") / 2;
      } else if (shape.type === "g") {
        // 组元素使用边界框
        ({ cx, cy } = shape.bbox());
      } else if (shape.type === "ellipse") {
        // 椭圆更简单
        cx = +shape.attr("cx");
        cy = +shape.attr("cy");
      } else {
        // 多边形使用特殊算法
        const points = parsePoints(pointsToNumberArray(shape.attr("points")));
        [cx, cy] = polylabel([points.map((point) => [point.x, point.y])]);
      }

      // 转换到客户端坐标系
      [clientX, clientY] = translateFromSVG(this.content, [cx, cy]);
      // 中心点就是clientX, clientY
      clientCX = clientX;
      clientCY = clientY;
    } else {
      // 自动位置（默认右上角）
      let box = (shape.node as any).getBBox();

      // 将整个边界框转换到客户端坐标系
      const [x1, y1, x2, y2]: number[] = translateFromSVG(this.content, [
        box.x,
        box.y,
        box.x + box.width,
        box.y + box.height,
      ]);

      // 计算中心点
      clientCX = x1 + (x2 - x1) / 2;
      clientCY = y1 + (y2 - y1) / 2;

      // 重新计算边界框
      box = {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.max(x1, x2) - Math.min(x1, x2),
        height: Math.max(y1, y2) - Math.min(y1, y2),
      };

      // 首先尝试放在右上角
      [clientX, clientY] = [box.x + box.width, box.y];
      // 如果超出可见区域，尝试放在左上角
      if (
        clientX +
          (text.node as any as SVGTextElement).getBBox().width +
          consts.TEXT_MARGIN >
        this.canvas.offsetWidth
      ) {
        [clientX, clientY] = [box.x, box.y];
      }
    }

    // 将找到的坐标转换为文本SVG坐标
    const [x, y, rotX, rotY]: number[] = translateToSVG(this.text, [
      clientX + (textPosition === "auto" ? consts.TEXT_MARGIN : 0),
      clientY + (textPosition === "auto" ? consts.TEXT_MARGIN : 0),
      options.rotation?.cx || clientCX,
      options.rotation?.cy || clientCY,
    ]);

    // 获取文本边界框
    const textBBox = (text.node as any as SVGTextElement).getBBox();
    // 最终绘制文本
    if (textPosition === "center") {
      // 居中显示
      text.move(x - textBBox.width / 2, y - textBBox.height / 2);
    } else {
      // 左上角或右上角显示
      text.move(x, y);
    }

    // 处理旋转
    let childOptions = {};
    if (rotation) {
      text.rotate(rotation, rotX, rotY);
      childOptions = {
        rotation: {
          angle: rotation,
          cx: clientCX,
          cy: clientCY,
        },
      };
    }

    // 如果是骨架类型，递归更新所有子元素的文本位置
    if (
      clientID in this.drawnStates &&
      this.drawnStates[clientID].shapeType === "skeleton"
    ) {
      this.drawnStates[clientID].elements!.forEach((element: DrawnState) => {
        if (element.clientID in this.svgTexts) {
          this.updateTextPosition(this.svgTexts[element.clientID], childOptions);
        }
      });
    }

    // 递归应用父元素的X坐标到所有子元素
    function applyParentX(parentText: SVGTSpanElement | SVGTextElement): void {
      for (let i = 0; i < parentText.children.length; i++) {
        if (i === 0) {
          // 不对齐第一个子元素
          continue;
        }

        const tspan = parentText.children[i];
        tspan.setAttribute("x", parentText.getAttribute("x")!);
        applyParentX(tspan as SVGTSpanElement);
      }
    }

    applyParentX(text.node as any as SVGTextElement);
  }

  /**
   * 保存对象状态，用于后续比较和更新
   * @param {any} state - 要保存的对象状态
   * @returns {DrawnState} 保存的状态对象
   */
  private saveState(state: any): DrawnState {
    const result = {
      clientID: state.clientID,
      outside: state.outside,
      occluded: state.occluded,
      source: state.source,
      hidden: state.hidden,
      lock: state.lock,
      shapeType: state.shapeType,
      points: [...state.points],
      rotation: state.rotation,
      attributes: { ...state.attributes },
      descriptions: [...state.descriptions],
      zOrder: state.zOrder,
      pinned: state.pinned,
      updated: state.updated,
      frame: state.frame,
      label: state.label,
      group: { id: state.group.id, color: state.group.color },
      color: state.color,
      // 如果是骨架类型，递归保存所有元素
      elements:
        state.shapeType === "skeleton"
          ? state.elements.map((element: any) => this.saveState(element))
          : null,
    };

    return result;
  }

  /**
   * 取消激活属性
   * 将当前激活的属性文本样式重置为默认，并清除激活状态
   */
  private deactivateAttribute(): void {
    const { clientID, attributeID } = this.activeElement;
    if (clientID !== null && attributeID !== null) {
      // 获取文本元素
      const text = this.svgTexts[clientID];
      if (text) {
        // 查找对应的属性文本元素
        const [span] = text.node.querySelectorAll(
          `[attrID="${attributeID}"]`
        ) as any as SVGTSpanElement[];
        if (span) {
          // 重置文本颜色为默认
          span.style.fill = "";
        }
      }

      // 清除激活的属性ID
      this.activeElement = {
        ...this.activeElement,
        attributeID: null,
      };
    }
  }

  /**
   * 将点坐标转换为画布坐标系
   * @param points - 原始点坐标数组
   * @returns 转换后的画布坐标系点坐标数组
   */
  private translateToCanvas(points: number[]): number[] {
    const { offset } = this.controller.geometry;
    return translateToCanvas(offset, points);
  }

  /**
   * 将画布坐标系点坐标转换为原始坐标
   * @param points - 画布坐标系点坐标数组
   * @returns 转换后的原始点坐标数组
   */
  private translateFromCanvas(points: number[]): number[] {
    const { offset } = this.controller.geometry;
    return translateFromCanvas(offset, points);
  }

  /**
   * 选择图形方法
   * 为图形添加或移除选择控制点，并设置相关事件处理
   * @param value - 是否启用选择，true为启用，false为禁用
   * @param shape - 要选择的SVG图形元素
   */
  private selectize(value: boolean, shape: SVG.Element): void {
    // 鼠标按下事件处理函数
    const mousedownHandler = (e: MouseEvent): void => {
      // 只处理左键点击
      if (e.button !== 0) return;
      e.preventDefault();

      // 确保有活动元素
      if (this.activeElement.clientID !== null) {
        // 获取点击的控制点ID
        const pointID = Array.prototype.indexOf.call(
          ((e.target as HTMLElement).parentElement as HTMLElement).children,
          e.target
        );
        // 获取当前活动对象状态
        const [state] = this.controller.objects.filter(
          (_state: any): boolean => _state.clientID === this.activeElement.clientID
        );

        // 只处理多边形、多段线和点集
        if (["polygon", "polyline", "points"].includes(state.shapeType)) {
          // 点集特殊处理
          if (state.shapeType === "points" && (e.altKey || e.ctrlKey)) {
            const selectedClientID = +(
              (e.target as HTMLElement).parentElement as HTMLElement
            ).getAttribute("clientID")!;

            if (state.clientID !== selectedClientID) {
              return;
            }
          }
          // Alt键点击：删除控制点
          if (e.altKey) {
            const { points } = state;
            // 确保点数量不会太少
            if (
              (state.shapeType === "polygon" && state.points.length > 6) ||
              (state.shapeType === "polyline" && state.points.length > 4) ||
              (state.shapeType === "points" && state.points.length > 2)
            ) {
              // 移除点击的控制点
              this.onEditDone(
                state,
                points.slice(0, pointID * 2).concat(points.slice(pointID * 2 + 2))
              );
            }
          } else if (e.shiftKey) {
            // Shift键点击：开始编辑控制点
            this.onEditStart(state);
            this.editHandler.edit({
              enabled: true,
              state,
              pointID,
            });
          }
        }
      }
    };

    // 双击事件处理函数
    const dblClickHandler = (e: MouseEvent): void => {
      e.preventDefault();

      // 确保有活动元素
      if (this.activeElement.clientID !== null) {
        const [state] = this.controller.objects.filter(
          (_state: any): boolean => _state.clientID === this.activeElement.clientID
        );

        // 立方体特殊处理
        if (state.shapeType === "cuboid") {
          if (e.shiftKey) {
            // 获取立方体点坐标并更新
            const points = this.translateFromCanvas(
              pointsToNumberArray(
                (e.target as any).parentElement.parentElement.instance.attr("points")
              )
            );
            this.onEditDone(state, points);
          }
        }
      }
    };

    // 右键菜单事件处理函数
    const contextMenuHandler = (e: MouseEvent): void => {
      // 获取点击的控制点ID
      const pointID = Array.prototype.indexOf.call(
        ((e.target as HTMLElement).parentElement as HTMLElement).children,
        e.target
      );
      // 确保有活动元素
      if (this.activeElement.clientID !== null) {
        const [state] = this.controller.objects.filter(
          (_state: any): boolean => _state.clientID === this.activeElement.clientID
        );
        // 分发右键菜单事件
        this.canvas.dispatchEvent(
          new CustomEvent("canvas.contextmenu", {
            bubbles: false,
            cancelable: true,
            detail: {
              mouseEvent: e,
              objectState: state,
              pointID,
            },
          })
        );
      }
      e.preventDefault();
    };

    // 启用选择
    if (value) {
      // 获取几何、控制器和活动元素的闭包函数
      const getGeometry = (): Geometry => this.geometry;
      const getController = (): CanvasController => this.controller;
      const getActiveElement = (): ActiveElement => this.activeElement;
      // 启用图形选择
      (shape as any).selectize(value, {
        deepSelect: true,
        pointSize: (2 * this.configuration.controlPointsSize!) / this.geometry.scale,
        rotationPoint: shape.type === "rect" || shape.type === "ellipse",
        pointsExclude:
          shape.type === "image" ? ["lt", "rt", "rb", "lb", "t", "r", "b", "l"] : [],
        // 自定义控制点类型
        pointType(cx: number, cy: number): SVG.Circle {
          // 创建控制点圆圈
          const circle: SVG.Circle = this.nested
            .circle(this.options.pointSize)
            .stroke("black")
            .fill("inherit")
            .center(cx, cy)
            .attr({
              "fill-opacity": 1,
              "stroke-width": consts.POINTS_STROKE_WIDTH / getGeometry().scale,
            });

          // 鼠标进入事件
          circle.on("mouseenter", (e: MouseEvent): void => {
            const activeElement = getActiveElement();
            // 点集特殊处理
            if (activeElement !== null && (e.altKey || e.ctrlKey)) {
              const [state] = getController().objects.filter(
                (_state: any): boolean => _state.clientID === activeElement.clientID
              );
              if (state?.shapeType === "points") {
                const selectedClientID = +(
                  (e.target as HTMLElement).parentElement as HTMLElement
                ).getAttribute("clientID")!;
                if (state.clientID !== selectedClientID) {
                  return;
                }
              }
            }

            // 高亮控制点
            circle.attr({
              "stroke-width": consts.POINTS_SELECTED_STROKE_WIDTH / getGeometry().scale,
            });

            // 添加事件监听
            circle.on("dblclick", dblClickHandler);
            circle.on("mousedown", mousedownHandler);
            circle.on("contextmenu", contextMenuHandler);
            circle.addClass("cvat_canvas_selected_point");
          });

          // 鼠标离开事件
          circle.on("mouseleave", (): void => {
            // 恢复控制点样式
            circle.attr({
              "stroke-width": consts.POINTS_STROKE_WIDTH / getGeometry().scale,
            });

            // 移除事件监听
            circle.off("dblclick", dblClickHandler);
            circle.off("mousedown", mousedownHandler);
            circle.off("contextmenu", contextMenuHandler);
            circle.removeClass("cvat_canvas_selected_point");
          });

          return circle;
        },
      });
    } else {
      // 禁用选择
      (shape as any).selectize(false, {
        deepSelect: true,
      });
    }

    // 设置选择处理器填充颜色
    const handler = shape.remember("_selectHandler");
    if (handler && handler.nested) {
      handler.nested.fill(shape.attr("fill"));
    }

    // 设置旋转点位置和提示
    const [rotationPoint] = window.document.getElementsByClassName(
      "svg_select_points_rot"
    );
    const [topPoint] = window.document.getElementsByClassName("svg_select_points_t");
    if (rotationPoint && !rotationPoint.children.length) {
      if (topPoint) {
        // 调整旋转点位置
        const rotY = +(rotationPoint as SVGEllipseElement).getAttribute("cy")!;
        const topY = +(topPoint as SVGEllipseElement).getAttribute("cy")!;
        (rotationPoint as SVGCircleElement).style.transform =
          `translate(0px, -${rotY - topY + 20}px)`;
      }

      // 添加提示文本
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = "Hold Shift to snap angle";
      rotationPoint.appendChild(title);
    }

    // 图像类型特殊处理
    if (value && shape.type === "image") {
      const [boundingRect] = window.document.getElementsByClassName(
        "svg_select_boundingRect"
      );
      if (boundingRect) {
        // 设置边界框样式
        (boundingRect as SVGRectElement).style.opacity = "1";
        boundingRect.setAttribute("fill", "none");
        boundingRect.setAttribute("stroke", shape.attr("stroke"));
        boundingRect.setAttribute(
          "stroke-width",
          `${consts.BASE_STROKE_WIDTH / this.geometry.scale}px`
        );
        // 如果图形被遮挡，设置虚线边框
        if (shape.hasClass("cvat_canvas_shape_occluded")) {
          boundingRect.setAttribute("stroke-dasharray", "5");
        }
      }
    }
  }

  /**
   * 设置点集到画布
   * @param basicPolyline - 基础折线元素
   * @param state - 图形状态对象，包含元素ID、Z轴顺序等
   * @returns 创建的SVG组元素
   */
  private setupPoints(basicPolyline: SVG.PolyLine, state: any | DrawnState): any {
    // 启用选择功能
    this.selectize(true, basicPolyline);

    // 创建组元素并设置基本属性
    const group: SVG.G = basicPolyline
      .remember("_selectHandler")
      .nested.addClass("cvat_canvas_shape")
      .attr({
        clientID: state.clientID,
        id: `cvat_canvas_shape_${state.clientID}`,
        "data-polyline-id": basicPolyline.attr("id"),
        "data-z-order": state.zOrder,
      });

    // 设置点击事件处理函数
    group.on("click.canvas", (event: MouseEvent): void => {
      // 需要在另一个元素上重新分发事件
      basicPolyline.fire(new MouseEvent("click", event));
      // 将事件重新分发到画布，以便能够通过点击合并点
      this.content.dispatchEvent(new MouseEvent("click", event));
    });

    // 将基础折线的方法绑定到组元素上
    group.bbox = basicPolyline.bbox.bind(basicPolyline);
    group.clone = basicPolyline.clone.bind(basicPolyline);

    return group;
  }

  /**
   * 重置视图位置
   * 根据对象的当前状态重置其在画布上的位置
   * @param clientID - 元素ID
   */
  private resetViewPosition(clientID: number): void {
    const drawnState = this.drawnStates[clientID];
    const drawnShape = this.svgShapes[clientID];

    if (drawnState && drawnShape) {
      const { shapeType, points } = drawnState;
      // 将点坐标转换为画布坐标系
      const translatedPoints: number[] = this.translateToCanvas(points!);
      const stringified = stringifyPoints(translatedPoints);

      // 根据图形类型处理不同的重置逻辑
      if (shapeType === "cuboid") {
        // 立方体图形：直接设置points属性
        drawnShape.attr("points", stringified);
      } else if (["polygon", "polyline", "points"].includes(shapeType)) {
        // 多边形、折线或点图形：使用plot方法设置点
        (drawnShape as SVG.PolyLine | SVG.Polygon).plot(stringified);
        if (shapeType === "points") {
          // 点图形：需要额外处理点选择和设置
          this.selectize(false, drawnShape);
          this.setupPoints(drawnShape as SVG.PolyLine, drawnState);
        }
      } else if (shapeType === "rectangle") {
        // 矩形图形：处理位置、大小和旋转
        const [xtl, ytl, xbr, ybr] = translatedPoints;
        drawnShape.rotate(0); // 先重置旋转
        drawnShape.size(xbr - xtl, ybr - ytl).move(xtl, ytl); // 设置大小和位置
        drawnShape.rotate(drawnState.rotation); // 恢复旋转
      } else if (shapeType === "ellipse") {
        // 椭圆图形：处理中心点、半径和旋转
        const [cx, cy, rightX, topY] = translatedPoints;
        const [rx, ry] = [rightX - cx, cy - topY];
        drawnShape.rotate(0); // 先重置旋转
        drawnShape.size(rx * 2, ry * 2).center(cx, cy); // 设置大小和中心
        drawnShape.rotate(drawnState.rotation); // 恢复旋转
      } else if (shapeType === "skeleton") {
        // 骨架图形：处理每个子元素的位置和旋转
        drawnShape.rotate(0); // 先重置旋转
        for (const child of (drawnShape as SVG.G).children()) {
          if (child.type === "circle") {
            const childClientID = child.attr("data-client-id");
            const element = drawnState.elements!.find(
              (el: any) => el.clientID === childClientID
            );
            const [x, y] = this.translateToCanvas(element!.points!);
            child.center(x, y); // 设置子元素中心位置
          }
        }
        drawnShape.rotate(drawnState.rotation); // 恢复旋转
      } else if (shapeType === "mask") {
        // 掩码图形：处理位置
        const [left, top] = points!.slice(-4);
        drawnShape.move(this.geometry.offset + left, this.geometry.offset + top);
      } else {
        throw new Error("Not implemented");
      }
    }
  }

  /**
   * 从旋转的图形中转换点坐标
   * 处理旋转图形的坐标转换，考虑图形的旋转角度和中心点
   * @param shape - SVG图形对象
   * @param points - 点坐标数组
   * @param cx - 旋转中心X坐标（可选）
   * @param cy - 旋转中心Y坐标（可选）
   * @returns 转换后的点坐标数组
   */
  private translatePointsFromRotatedShape(
    shape: SVG.Shape,
    points: number[],
    cx: number | null = null,
    cy: number | null = null
  ): number[] {
    // 获取图形的当前旋转角度
    const { rotation } = shape.transform();
    // 当前图形被旋转并可能被CSS transform属性额外移动
    // 让我们移除旋转以获取正确的变换矩阵（元素->屏幕）
    // 正确意味着我们不认为点被旋转了
    // 因为旋转属性是单独存储并已保存的
    if (cx !== null && cy !== null) {
      shape.rotate(0, cx, cy);
    } else {
      shape.rotate(0);
    }

    const result = [];

    try {
      // 获取每个点并应用几个矩阵变换
      const point = this.content.createSVGPoint();
      // 从元素坐标系转换到客户端坐标系的矩阵
      const ctm = (
        shape.node as any as
          | SVGRectElement
          | SVGPolygonElement
          | SVGPolylineElement
          | SVGGElement
      ).getScreenCTM();
      // 从客户端坐标系转换到画布坐标系的矩阵
      const ctm1 = this.content.getScreenCTM()!.inverse();
      // 注意：我尝试使用element.getCTM()，但这种方式在firefox上不工作

      for (let i = 0; i < points.length; i += 2) {
        // 设置点的坐标
        point.x = points[i];
        point.y = points[i + 1];
        // 应用第一个矩阵变换
        let transformedPoint = point.matrixTransform(ctm ?? undefined);
        // 应用第二个矩阵变换
        transformedPoint = transformedPoint.matrixTransform(ctm1);

        result.push(transformedPoint.x, transformedPoint.y);
      }
    } finally {
      // 恢复图形的原始旋转角度
      if (cx !== null && cy !== null) {
        shape.rotate(rotation!, cx, cy);
      } else {
        shape.rotate(rotation!);
      }
    }

    return result;
  }

  /**
   * 删除对象及其相关元素
   * @param {any[]} states - 要删除的对象状态数组
   */
  private deleteObjects(states: any[]): void {
    for (const state of states) {
      // 删除文本元素
      if (state.clientID in this.svgTexts) {
        this.deleteText(state.clientID);
      }

      // 如果是骨架类型，递归删除所有元素
      if (state.shapeType === "skeleton") {
        this.deleteObjects(state.elements);
      }

      // 删除图形元素
      if (state.clientID in this.svgShapes) {
        // 触发移除事件
        this.svgShapes[state.clientID].fire("remove");
        // 移除事件监听器
        this.svgShapes[state.clientID].off("click");
        this.svgShapes[state.clientID].off("remove");
        // 从DOM中移除
        this.svgShapes[state.clientID].remove();
        delete this.svgShapes[state.clientID];
      }

      // 删除已保存的状态
      if (state.clientID in this.drawnStates) {
        delete this.drawnStates[state.clientID];
      }
    }
  }

  /**
   * 添加新对象到画布
   * @param {any[]} states - 要添加的对象状态数组
   */
  private addObjects(states: any[]): void {
    const { displayAllText } = this.configuration;
    for (const state of states) {
      const points: number[] = state.points as number[];

      // 根据图形类型创建相应的SVG元素
      if (state.shapeType === "mask") {
        this.svgShapes[state.clientID] = this.addMask(points, state);
      } else if (state.shapeType === "skeleton") {
        this.svgShapes[state.clientID] = this.addSkeleton(state);
      } else {
        // 将点转换为画布坐标
        const translatedPoints: number[] = this.translateToCanvas(points);
        if (state.shapeType === "rectangle") {
          this.svgShapes[state.clientID] = this.addRect(translatedPoints, state);
        } else {
          const stringified = stringifyPoints(translatedPoints);

          if (state.shapeType === "polygon") {
            this.svgShapes[state.clientID] = this.addPolygon(stringified, state);
          } else if (state.shapeType === "polyline") {
            this.svgShapes[state.clientID] = this.addPolyline(stringified, state);
          } else if (state.shapeType === "points") {
            this.svgShapes[state.clientID] = this.addPoints(stringified, state);
          } else if (state.shapeType === "ellipse") {
            this.svgShapes[state.clientID] = this.addEllipse(stringified, state);
          } else {
            continue;
          }
        }
      }

      // 为图形添加点击事件监听器
      this.svgShapes[state.clientID].on("click.canvas", (): void => {
        this.canvas.dispatchEvent(
          new CustomEvent("canvas.clicked", {
            bubbles: false,
            cancelable: true,
            detail: {
              state,
            },
          })
        );
      });

      // 如果配置显示所有文本，添加文本标签
      if (displayAllText) {
        this.addText(state);
        this.updateTextPosition(this.svgTexts[state.clientID]);
      }

      // 保存当前状态
      this.drawnStates[state.clientID] = this.saveState(state);
    }
  }

  /**
   * 添加掩码到画布
   * @param points - 掩码点数组，最后四个元素为[left, top, right, bottom]边界
   * @param state - 图形状态对象，包含元素ID、颜色、遮挡状态等
   * @returns 创建的SVG图像元素
   */
  private addMask(points: number[], state: any): SVG.Image {
    // 获取图形颜色配置
    const colorization = this.getShapeColorization(state);
    // 将十六进制颜色转换为RGB值
    const color = fabric.Color.fromHex(colorization.fill).getSource();
    // 提取边界坐标
    const [left, top, right, bottom] = points.slice(-4);
    // 扩展颜色通道，生成图像位图数据
    const imageBitmap = expandChannels(color[0], color[1], color[2], points);

    // 创建图像元素并设置基本属性
    const image = this.adoptedContent
      .image()
      .attr({
        clientID: state.clientID,
        "color-rendering": "optimizeQuality",
        id: `cvat_canvas_shape_${state.clientID}`,
        "shape-rendering": "geometricprecision",
        "data-z-order": state.zOrder,
        // 应用sqrt函数增强掩码在画布上的显示效果
        opacity: Math.sqrt(colorization["fill-opacity"]),
        stroke: colorization.stroke,
      })
      .addClass("cvat_canvas_shape");
    // 设置图像位置（考虑几何偏移）
    image.move(this.geometry.offset + left, this.geometry.offset + top);

    // 将图像位图数据转换为DataURL并加载到图像元素
    imageDataToDataURL(
      imageBitmap,
      right - left + 1, // 宽度
      bottom - top + 1, // 高度
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

    // 如果图形被遮挡，添加遮挡样式
    if (state.occluded) {
      image.addClass("cvat_canvas_shape_occluded");
    }

    // 如果图形被隐藏、在画布外或内部隐藏，添加隐藏样式
    if (state.hidden || state.outside || this.isInnerHidden(state.clientID)) {
      image.addClass("cvat_canvas_hidden");
    }

    // 如果是基准真相，添加基准真相样式
    if (state.isGroundTruth) {
      image.addClass("cvat_canvas_ground_truth");
    }

    return image;
  }

  /**
   * 检查对象是否被内部隐藏
   * 根据内部标志检查对象是否在绘制、编辑或切片模式下被隐藏
   * @param clientID - 元素ID
   * @returns 如果对象被隐藏返回true，否则返回false
   */
  private isInnerHidden(clientID: number): boolean {
    return (
      this.innerObjectsFlags.drawHidden[clientID] ||
      this.innerObjectsFlags.editHidden[clientID] ||
      this.innerObjectsFlags.sliceHidden[clientID] ||
      false
    );
  }

  /**
   * 激活指定元素（图形或属性）
   * 根据当前激活状态决定是否需要取消激活之前的元素，然后激活新元素
   * @param {ActiveElement} activeElement - 要激活的元素，包含元素ID和属性ID
   */
  private activate(activeElement: ActiveElement): void {
    // 检查是否已有其他元素被激活
    if (this.activeElement.clientID !== null) {
      if (this.activeElement.clientID !== activeElement.clientID) {
        // 如果是不同的图形，取消激活之前的图形和属性
        this.deactivate();
      } else if (this.activeElement.attributeID !== activeElement.attributeID) {
        // 如果是相同图形但不同属性，只取消激活属性
        this.deactivateAttribute();
      }
    }

    const { clientID, attributeID } = activeElement;
    // 如果需要激活新的图形
    if (clientID !== null && this.activeElement.clientID !== clientID) {
      this.activateShape(clientID);
      this.activeElement = {
        ...this.activeElement,
        clientID,
      };
    }

    // 如果需要激活新的属性
    if (
      clientID !== null &&
      attributeID !== null &&
      this.activeElement.attributeID !== attributeID
    ) {
      this.activateAttribute(clientID, attributeID);
    }
  }

  /**
   * 高亮显示指定元素
   * 为指定元素添加高亮样式，并处理遮罩类型的重绘
   * @param {HighlightedElements} highlightedElements - 要高亮的元素列表和严重程度
   */
  private highlight(highlightedElements: HighlightedElements): void {
    // 移除之前高亮元素的高亮样式
    this.highlightedElements.elementsIDs.forEach((clientID) => {
      const shapeView = window.document.getElementById(`cvat_canvas_shape_${clientID}`);
      if (shapeView) shapeView.classList.remove(this.getHighlightClassname());
    });

    // 检查是否需要重绘遮罩（高亮状态发生变化时）
    const redrawMasks =
      highlightedElements.elementsIDs.length !== 0 ||
      this.highlightedElements.elementsIDs.length !== 0;

    // 如果有需要高亮的元素
    if (highlightedElements.elementsIDs.length) {
      // 更新高亮元素列表
      this.highlightedElements = { ...highlightedElements };
      // 添加高亮样式类
      this.canvas.classList.add("cvat-canvas-highlight-enabled");
      // 为每个元素添加高亮样式
      this.highlightedElements.elementsIDs.forEach((clientID) => {
        const shapeView = window.document.getElementById(`cvat_canvas_shape_${clientID}`);
        if (shapeView) shapeView.classList.add(this.getHighlightClassname());
      });
    } else {
      // 清空高亮元素列表
      this.highlightedElements = {
        elementsIDs: [],
        severity: null,
      };
      // 移除高亮样式类
      this.canvas.classList.remove("cvat-canvas-highlight-enabled");
    }

    // 如果需要重绘遮罩
    if (redrawMasks) {
      const masks = Object.values(this.drawnStates).filter(
        (state) => state.shapeType === "mask"
      );
      this.deleteObjects(masks);
      this.addObjects(masks);
    }

    // 如果有高亮元素，激活第一个元素
    if (this.highlightedElements.elementsIDs.length) {
      this.deactivate();
      const clientID = this.highlightedElements.elementsIDs[0];
      this.activate({ clientID, attributeID: null });
    }
  }

  /**
   * 获取高亮元素的CSS类名
   * @returns {string} 根据高亮严重程度返回相应的CSS类名
   */
  private getHighlightClassname(): string {
    const { severity } = this.highlightedElements;
    if (severity === HighlightSeverity.ERROR) {
      return "cvat_canvas_conflicted";
    }
    if (severity === HighlightSeverity.WARNING) {
      return "cvat_canvas_warned";
    }
    return "";
  }

  /**
   * 检查对象状态是否被锁定
   * 根据对象自身的锁定状态和全局配置判断是否可以编辑
   * @param state - 对象状态
   * @returns 如果状态被锁定返回true，否则返回false
   */
  private stateIsLocked(state: any): boolean {
    const { configuration } = this.controller;
    // 检查对象自身的锁定状态或全局配置是否强制禁用编辑
    return state.lock || configuration.forceDisableEditing;
  }

  /**
   * 激活图形
   * 设置图形为激活状态，添加交互功能，包括拖拽、调整大小等
   * @param {number} clientID - 要激活的图形的元素ID
   */
  private activateShape(clientID: number): void {
    // 获取对应的状态对象
    const [state] = this.controller.objects.filter(
      (_state: any): boolean => _state.clientID === clientID
    );
    // 如果是点类型，设置鼠标事件样式
    if (state && state.shapeType === "points") {
      this.svgShapes[clientID]
        .remember("_selectHandler")
        .nested.style("pointer-events", this.stateIsLocked(state) ? "none" : "");
    }

    // 如果状态不存在、隐藏或在画布外，则不激活
    if (!state || state.hidden || state.outside) {
      return;
    }

    // 获取图形元素
    const shape = this.svgShapes[clientID];
    // 如果文本不存在，添加文本
    if (!this.svgTexts[clientID]) {
      this.addText(state);
    }
    // 更新文本位置
    this.updateTextPosition(this.svgTexts[clientID]);

    // 如果状态被锁定，不添加交互功能
    if (this.stateIsLocked(state)) {
      return;
    }

    // 添加激活状态的CSS类
    if (state.shapeType === "points") {
      this.svgShapes[clientID]
        .remember("_selectHandler")
        .nested.addClass("cvat_canvas_shape_activated");
    } else {
      shape.addClass("cvat_canvas_shape_activated");
    }

    // 设置激活状态的透明度
    if (state.shapeType === "mask") {
      shape.attr("opacity", `${Math.sqrt(this.configuration.selectedShapeOpacity!)}`);
    } else {
      shape.attr("fill-opacity", `${this.configuration.selectedShapeOpacity}`);
    }

    // 将图形移到内容区域的最后（最顶层）
    if (state.shapeType === "points") {
      this.content.append(
        this.svgShapes[clientID].remember("_selectHandler").nested.node
      );
    } else {
      this.content.append(shape.node);
    }

    // 如果不是点类型，启用选择功能
    if (state.shapeType !== "points") {
      this.selectize(true, shape);
    }

    // 获取所有相关文本元素（包括骨架的子元素）
    const textList = [
      state.clientID,
      ...state.elements.map((element: any): number => element.clientID),
    ]
      .map((id: number) => this.svgTexts[id])
      .filter((text: SVG.Text | undefined) => typeof text !== "undefined");

    // 隐藏文本的函数
    const hideText = (): void => {
      textList.forEach((text: SVG.Text) => {
        text.addClass("cvat_canvas_hidden");
      });
    };

    // 显示文本的函数
    const showText = (): void => {
      textList.forEach((text: SVG.Text) => {
        text.removeClass("cvat_canvas_hidden");
        this.updateTextPosition(text);
      });
    };

    // 如果不是遮罩类型，设置调整大小和方向指示器
    if (state.shapeType !== "mask") {
      // 显示方向指示器的函数
      const showDirection = (): void => {
        if (["polygon", "polyline"].includes(state.shapeType)) {
          this.showDirection(state, shape as SVG.Polygon | SVG.PolyLine);
        }
      };

      // 隐藏方向指示器的函数
      const hideDirection = (): void => {
        if (["polygon", "polyline"].includes(state.shapeType)) {
          this.hideDirection(shape as SVG.Polygon | SVG.PolyLine);
        }
      };

      // 图形大小显示元素
      let shapeSizeElement: ShapeSizeElement | null = null;
      // 设置调整大小功能
      this.resizable(
        state,
        shape,
        () => {
          // 开始调整大小时
          this.mode = Mode.RESIZE;
          hideDirection();
          hideText();
          // 如果是矩形或椭圆，显示图形大小
          if (state.shapeType === "rectangle" || state.shapeType === "ellipse") {
            shapeSizeElement = displayShapeSize(this.adoptedContent, this.adoptedText);
          }
        },
        () => {
          // 调整大小时
          if (shapeSizeElement) {
            shapeSizeElement.update(shape);
          }
        },
        () => {
          // 结束调整大小时
          this.mode = Mode.IDLE;
          if (shapeSizeElement) {
            shapeSizeElement.rm();
            shapeSizeElement = null;
          }

          showDirection();
          showText();
        }
      );

      // 显示方向指示器
      showDirection();
    } else {
      // 遮罩类型添加双击编辑功能
      (shape as any).on("dblclick", (e: MouseEvent) => {
        if (e.shiftKey) {
          this.controller.edit({ enabled: true, state });
          e.stopPropagation();
        }
      });
    }

    // 如果图形未固定，设置拖拽功能
    if (!state.pinned) {
      this.draggable(
        state,
        shape,
        () => {
          // 开始拖拽时
          this.mode = Mode.DRAG;
          hideText();
        },
        () => {
          // 拖拽时（空函数）
        },
        () => {
          // 结束拖拽时
          this.mode = Mode.IDLE;
          showText();
        }
      );
    }

    // 触发图形激活事件
    this.canvas.dispatchEvent(
      new CustomEvent("canvas.activated", {
        bubbles: false,
        cancelable: true,
        detail: {
          state,
        },
      })
    );
  }

  /**
   * 激活属性
   * 将指定属性文本设置为红色，表示当前激活状态
   * @param {number} clientID - 对象的元素ID
   * @param {number} attributeID - 属性的ID
   */
  private activateAttribute(clientID: number, attributeID: number): void {
    // 获取文本元素
    const text = this.svgTexts[clientID];
    if (text) {
      // 查找对应的属性文本元素
      const [span] = text.node.querySelectorAll(
        `[attrID="${attributeID}"]`
      ) as any as SVGTSpanElement[];
      if (span) {
        // 设置文本颜色为红色，表示激活状态
        span.style.fill = "red";
      }

      // 更新激活的属性ID
      this.activeElement = {
        ...this.activeElement,
        attributeID,
      };
    }
  }

  /**
   * 添加骨架到画布
   * @param state - 图形状态对象，包含元素ID、元素列表、结构等
   * @returns 创建的SVG骨架元素组
   */
  private addSkeleton(state: any): any {
    // 创建骨架组元素并设置基本属性
    const skeleton = (this.adoptedContent as any)
      .group()
      .attr({
        clientID: state.clientID,
        "color-rendering": "optimizeQuality",
        id: `cvat_canvas_shape_${state.clientID}`,
        "shape-rendering": "geometricprecision",
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "data-z-order": state.zOrder,
        "pointer-events": "all",
        ...this.getShapeColorization(state),
      })
      .addClass("cvat_canvas_shape cvat_canvas_shape_skeleton") as SVG.G;

    // 从模板创建SVG元素
    const SVGElement = makeSVGFromTemplate(state.label.structure.svg);

    // 初始化边界框坐标
    let xtl: number | null = null;
    let ytl: number | null = null;
    let xbr: number | null = null;
    let ybr: number | null = null;
    const svgElements: Record<number, SVG.Element> = {};
    // 获取模板中的圆形元素（用于骨架节点）
    const templateElements = Array.from(SVGElement.children()).filter(
      (el: SVG.Element) => el.type === "circle"
    );

    // 遍历骨架元素，创建对应的SVG元素
    for (let i = 0; i < state.elements.length; i++) {
      const element = state.elements[i];
      if (element.shapeType === "points") {
        const points: number[] = element.points as number[];
        // 将点坐标转换为画布坐标
        const [cx, cy] = this.translateToCanvas(points);

        // 更新边界框坐标（仅当元素不在画布外时）
        if (!element.outside) {
          xtl = xtl === null ? cx : Math.min(xtl, cx);
          ytl = ytl === null ? cy : Math.min(ytl, cy);
          xbr = xbr === null ? cx : Math.max(xbr, cx);
          ybr = ybr === null ? cy : Math.max(ybr, cy);
        }

        // 查找对应的模板元素
        const templateElement = templateElements.find((value: SVG.Element) => {
          const el = value as SVG.Circle;
          return el.attr("data-label-id") === element.label.id;
        });
        // 创建圆形节点
        const circle = skeleton
          .circle()
          .center(cx, cy)
          .attr({
            id: `cvat_canvas_shape_${element.clientID}`,
            r: this.configuration.controlPointsSize! / this.geometry.scale,
            "color-rendering": "optimizeQuality",
            "shape-rendering": "geometricprecision",
            "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
            "data-node-id": templateElement!.attr("data-node-id"),
            "data-element-id": templateElement!.attr("data-element-id"),
            "data-label-id": templateElement!.attr("data-label-id"),
            "data-client-id": element.clientID,
            ...this.getShapeColorization(element, { parentState: state }),
          })
          .style({
            cursor: "default",
          });

        // 保存圆形节点引用
        this.svgShapes[element.clientID] = circle;

        // 如果元素被遮挡，添加遮挡样式
        if (element.occluded) {
          circle.addClass("cvat_canvas_shape_occluded");
        }

        // 如果元素被隐藏、在画布外或内部隐藏，添加隐藏样式
        if (element.hidden || element.outside || this.isInnerHidden(element.clientID)) {
          circle.addClass("cvat_canvas_hidden");
        }

        // 定义鼠标悬停事件处理函数
        const mouseover = (e: MouseEvent): void => {
          const locked = this.drawnStates[state.clientID].lock;
          if (!locked && !e.ctrlKey && this.mode === Mode.IDLE) {
            // 增加描边宽度以表示选中状态
            circle.attr({
              "stroke-width": consts.POINTS_SELECTED_STROKE_WIDTH / this.geometry.scale,
            });

            // 转换坐标并触发画布移动事件
            const [x, y] = translateToSVG(this.content, [e.clientX, e.clientY]);
            const event: CustomEvent = new CustomEvent("canvas.moved", {
              bubbles: false,
              cancelable: true,
              detail: {
                x: x - this.geometry.offset,
                y: y - this.geometry.offset,
                activatedElementID: element.clientID,
                states: this.controller.objects,
              },
            });

            this.canvas.dispatchEvent(event);
          }
        };

        // 定义鼠标移动事件处理函数
        const mousemove = (e: MouseEvent): void => {
          if (this.mode === Mode.IDLE) {
            // 停止事件传播，防止画布调用另一个canvas.moved事件
            // 并且不允许激活元素
            e.stopPropagation();
          }
        };

        // 定义鼠标离开事件处理函数
        const mouseleave = (): void => {
          // 恢复默认描边宽度
          circle.attr({
            "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
          });
        };

        // 定义点击事件处理函数
        const click = (e: MouseEvent): void => {
          e.stopPropagation();
          this.canvas.dispatchEvent(
            new CustomEvent("canvas.clicked", {
              bubbles: false,
              cancelable: true,
              detail: {
                state: element,
              },
            })
          );
        };

        // 绑定事件监听器
        circle.on("mouseover", mouseover);
        circle.on("mouseleave", mouseleave);
        circle.on("mousemove", mousemove);
        circle.on("click", click);
        circle.on("remove", () => {
          circle.off("remove");
          circle.off("mouseover", mouseover);
          circle.off("mouseleave", mouseleave);
          circle.off("mousemove", mousemove);
          circle.off("click", click);
        });

        // 保存元素引用
        svgElements[element.clientID] = circle;
      }
    }

    // 如果所有元素都在画布外，设置坐标为零
    xtl = xtl || 0;
    ytl = ytl || 0;
    xbr = xbr || 0;
    ybr = ybr || 0;

    // 应用边界框边距
    xtl -= consts.SKELETON_RECT_MARGIN;
    ytl -= consts.SKELETON_RECT_MARGIN;
    xbr += consts.SKELETON_RECT_MARGIN;
    ybr += consts.SKELETON_RECT_MARGIN;

    // 设置骨架移除事件处理
    skeleton.on("remove", () => {
      Object.values(svgElements).forEach((element) => element.fire("remove"));
      skeleton.off("remove");
    });

    // 创建包裹矩形，用于骨架的交互和选择
    const wrappingRect = skeleton
      .rect(xbr - xtl, ybr - ytl)
      .move(xtl, ytl)
      .attr({
        fill: "inherit",
        "fill-opacity": 0,
        "color-rendering": "optimizeQuality",
        "shape-rendering": "geometricprecision",
        stroke: "inherit",
        "stroke-width": "inherit",
        "data-xtl": xtl,
        "data-ytl": ytl,
        "data-xbr": xbr,
        "data-ybr": ybr,
      })
      .addClass("cvat_canvas_skeleton_wrapping_rect");

    // 将包裹矩形添加到骨架节点的开头
    skeleton.node.prepend(wrappingRect.node);
    // 设置骨架边缘连接
    setupSkeletonEdges(skeleton, SVGElement);

    // 如果骨架被遮挡，添加遮挡样式
    if (state.occluded) {
      skeleton.addClass("cvat_canvas_shape_occluded");
    }

    // 如果是基准真相，添加基准真相样式
    if (state.isGroundTruth) {
      skeleton.addClass("cvat_canvas_ground_truth");
    }

    // 如果骨架被隐藏、在画布外或内部隐藏，添加隐藏样式
    if (state.hidden || state.outside || this.isInnerHidden(state.clientID)) {
      skeleton.addClass("cvat_canvas_hidden");
    }

    // 为骨架添加自定义选择方法
    (skeleton as any).selectize = (enabled: boolean) => {
      this.selectize(enabled, wrappingRect);
      const handler = wrappingRect.remember("_selectHandler");
      if (enabled && handler) {
        this.adoptedContent.node.append(handler.nested.node);
        handler.nested.attr("fill", skeleton.attr("fill"));
      }

      return skeleton;
    };

    return skeleton;
  }

  /**
   * 设置对象方法
   * 根据传入的状态数组更新画布上显示的对象
   * @param states - 对象状态数组，包含所有需要在画布上显示的对象
   */
  private setupObjects(states: any[]): void {
    const created = [];
    const updated = [];

    // 遍历所有状态，区分新建和更新的对象
    for (const state of states) {
      if (!(state.clientID in this.drawnStates)) {
        // 新建对象
        created.push(state);
      } else {
        const drawnState = this.drawnStates[state.clientID];
        // 对象已更改或跟踪对象更改了帧
        if (drawnState.updated !== state.updated || drawnState.frame !== state.frame) {
          updated.push(state);
        }
      }
    }

    // 找出已删除的对象
    const newIDs = states.map((state: any): number => state.clientID);
    const deleted = Object.keys(this.drawnStates)
      .map((clientID: string): number => +clientID)
      .filter((id: number): boolean => !newIDs.includes(id))
      .map((id: number): any => this.drawnStates[id]);

    // 如果有对象变化，执行更新操作
    if (deleted.length || updated.length || created.length) {
      // 如果有活动元素，先取消激活
      if (this.activeElement.clientID !== null) {
        this.deactivate();
      }

      // 删除已删除的对象
      this.deleteObjects(deleted);
      // 添加新建的对象
      this.addObjects(created);

      // 分离骨架和非骨架对象
      const updatedSkeletons = updated.filter(
        (state: any): boolean => state.shapeType === "skeleton"
      );
      const updatedNotSkeletons = updated.filter(
        (state: any): boolean => state.shapeType !== "skeleton"
      );
      // TODO: 为骨架实现updateObjects方法，向updateObjects函数添加组和颜色
      // 如有必要更改颜色（例如实例颜色更改时）
      this.updateObjects(updatedNotSkeletons);

      // 删除并重新添加骨架对象（因为骨架更新逻辑复杂）
      this.deleteObjects(updatedSkeletons);
      this.addObjects(updatedSkeletons);

      // 对对象进行排序
      this.sortObjects();

      // 如果控制器有活动元素，重新激活
      if (this.controller.activeElement.clientID !== null) {
        const { clientID } = this.controller.activeElement;
        if (states.map((state: any): number => state.clientID).includes(clientID)) {
          this.activate(this.controller.activeElement);
        }
      }

      // 更新自动边框处理器的对象
      this.autoborderHandler.updateObjects();
    }
  }

  /**
   * 更新现有对象的状态和外观
   * 根据新状态更新图形、文本和属性
   * @param {any[]} states - 要更新的对象状态数组
   */
  private updateObjects(states: any[]): void {
    for (const state of states) {
      const { clientID } = state;
      // 获取当前已绘制的状态
      const drawnState = this.drawnStates[clientID];
      // 获取图形和文本元素
      const shape = this.svgShapes[state.clientID];
      const text = this.svgTexts[state.clientID];
      // 判断对象是否不可见
      const isInvisible =
        state.hidden || state.outside || this.isInnerHidden(state.clientID);

      // 处理隐藏状态变化
      if (drawnState.hidden !== state.hidden || drawnState.outside !== state.outside) {
        if (isInvisible) {
          // 添加隐藏类
          (state.shapeType === "points"
            ? shape.remember("_selectHandler").nested
            : shape
          ).addClass("cvat_canvas_hidden");
          if (text) {
            text.addClass("cvat_canvas_hidden");
          }
        } else {
          // 移除隐藏类
          (state.shapeType === "points"
            ? shape.remember("_selectHandler").nested
            : shape
          ).removeClass("cvat_canvas_hidden");
          if (text) {
            text.removeClass("cvat_canvas_hidden");
            // 更新文本位置
            this.updateTextPosition(text);
          }
        }
      }

      // 处理Z轴顺序变化
      if (drawnState.zOrder !== state.zOrder) {
        if (state.shapeType === "points") {
          shape.remember("_selectHandler").nested.attr("data-z-order", state.zOrder);
        } else {
          shape.attr("data-z-order", state.zOrder);
        }
      }

      // 处理遮挡状态变化
      if (drawnState.occluded !== state.occluded) {
        const instance =
          state.shapeType === "points"
            ? this.svgShapes[clientID].remember("_selectHandler").nested
            : shape;
        if (state.occluded) {
          instance.addClass("cvat_canvas_shape_occluded");
        } else {
          instance.removeClass("cvat_canvas_shape_occluded");
        }
      }

      // 处理固定状态变化
      if (drawnState.pinned !== state.pinned && this.activeElement.clientID !== null) {
        const activeElement = { ...this.activeElement };
        // 先取消激活，再重新激活以更新状态
        this.deactivate();
        this.activate(activeElement);
      }

      // 如果有旋转，先取消旋转以便更新点
      if (drawnState.rotation) {
        shape.untransform();
      }

      // 检查点是否已更新
      const pointsUpdated =
        state.points.length !== drawnState.points?.length ||
        state.points.some(
          (p: number, id: number): boolean => p !== drawnState.points?.[id]
        );

      // 处理点更新
      if (pointsUpdated) {
        if (state.shapeType === "mask") {
          // 遮罩类型需要重新绘制
          this.deleteObjects([this.drawnStates[+clientID]]);
          this.addObjects([state]);
          continue;
        }

        // 将点转换为画布坐标
        const translatedPoints: number[] = this.translateToCanvas(state.points);

        if (state.shapeType === "rectangle") {
          const [xtl, ytl, xbr, ybr] = translatedPoints;
          // 更新矩形的位置和大小
          shape.attr({
            x: xtl,
            y: ytl,
            width: xbr - xtl,
            height: ybr - ytl,
          });
        } else if (state.shapeType === "ellipse") {
          const [cx, cy] = translatedPoints;
          const [rx, ry] = [translatedPoints[2] - cx, cy - translatedPoints[3]];
          // 更新椭圆的中心和半径
          shape.attr({
            cx,
            cy,
            rx,
            ry,
          });
        } else {
          const stringified = stringifyPoints(translatedPoints);
          if (state.shapeType !== "cuboid") {
            // 清除现有路径（立方体除外）
            (shape as any).clear();
          }
          // 更新点
          shape.attr("points", stringified);

          // 如果是点类型且可见，重新设置选择器和点
          if (state.shapeType === "points" && !isInvisible) {
            this.selectize(false, shape);
            this.setupPoints(shape as SVG.PolyLine, state);
          }
        }
      }

      // 如果有旋转，应用新的旋转角度
      if (state.rotation) {
        shape.rotate(state.rotation);
      }

      // 获取当前状态和已绘制状态的描述
      const stateDescriptions = state.descriptions;
      const drawnStateDescriptions = drawnState.descriptions;
      const rotationUpdated = drawnState.rotation !== state.rotation;

      // 检查是否需要更新文本
      if (
        drawnState.label.id !== state.label.id ||
        pointsUpdated ||
        rotationUpdated ||
        drawnStateDescriptions.length !== stateDescriptions.length ||
        drawnStateDescriptions.some(
          (desc: string, id: number): boolean => desc !== stateDescriptions[id]
        )
      ) {
        // 移除旧文本并创建新文本
        if (text) {
          text.remove();
          this.addText(state);
        }
      } else {
        // 创建属性名映射
        const attrNames = Object.fromEntries(
          state.label.attributes.map((attr: any) => [attr.id, attr.name])
        );
        // 检查属性是否有更新
        for (const attrID of Object.keys(state.attributes)) {
          if (state.attributes[attrID] !== drawnState.attributes[+attrID]) {
            if (text) {
              // 查找对应的文本元素并更新
              const [span] = text.node.querySelectorAll<SVGTSpanElement>(
                `[attrID="${attrID}"]`
              );
              if (span && span.textContent) {
                span.textContent = `${attrNames[attrID]}: ${state.attributes[attrID]}`;
              }
            }
          }
        }
      }

      // 检查是否需要更新图形颜色
      if (
        drawnState.label.id !== state.label.id ||
        drawnState.group.id !== state.group.id ||
        drawnState.group.color !== state.group.color ||
        drawnState.color !== state.color
      ) {
        if (shape) {
          if (state.shapeType === "mask") {
            // 遮罩类型需要重新绘制
            this.deleteObjects([this.drawnStates[+clientID]]);
            this.addObjects([state]);
            continue;
          } else if (state.shapeType === "points") {
            // 点类型需要同时更新嵌套元素和主元素的颜色
            const colorization = { ...this.getShapeColorization(state) };
            shape.remember("_selectHandler").nested.attr(colorization);
            shape.attr(colorization);
          } else {
            // 更新图形颜色
            shape.attr({ ...this.getShapeColorization(state) });
          }
        }
      }

      // 保存当前状态
      this.drawnStates[state.clientID] = this.saveState(state);
    }
  }

  /**
   * 添加矩形到画布
   * @param points - 矩形坐标点 [左上角x, 左上角y, 右下角x, 右下角y]
   * @param state - 图形状态对象，包含元素ID、旋转角度、遮挡状态等
   * @returns 创建的SVG矩形元素
   */
  private addRect(points: number[], state: any): SVG.Rect {
    // 解构矩形坐标点
    const [xtl, ytl, xbr, ybr] = points;
    // 创建矩形元素并设置基本属性
    const rect = this.adoptedContent
      .rect()
      .size(xbr - xtl, ybr - ytl) // 设置宽度和高度
      .attr({
        clientID: state.clientID,
        "color-rendering": "optimizeQuality",
        id: `cvat_canvas_shape_${state.clientID}`,
        "shape-rendering": "geometricprecision",
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "data-z-order": state.zOrder,
        ...this.getShapeColorization(state), // 应用图形颜色配置
      })
      .move(xtl, ytl)
      .addClass("cvat_canvas_shape");

    // 如果有旋转角度，应用旋转
    if (state.rotation) {
      rect.rotate(state.rotation);
    }

    // 如果图形被遮挡，添加遮挡样式
    if (state.occluded) {
      rect.addClass("cvat_canvas_shape_occluded");
    }

    // 如果图形被隐藏、在画布外或内部隐藏，添加隐藏样式
    if (state.hidden || state.outside || this.isInnerHidden(state.clientID)) {
      rect.addClass("cvat_canvas_hidden");
    }

    // 如果是基准真相，添加基准真相样式
    if (state.isGroundTruth) {
      rect.addClass("cvat_canvas_ground_truth");
    }

    return rect;
  }

  /**
   * 添加多边形到画布
   * @param points - 多边形顶点坐标字符串，格式为"x1,y1 x2,y2 ..."
   * @param state - 图形状态对象，包含元素ID、遮挡状态等
   * @returns 创建的SVG多边形元素
   */
  private addPolygon(points: string, state: any): SVG.Polygon {
    // 创建多边形元素并设置基本属性
    const polygon = this.adoptedContent
      .polygon(points)
      .attr({
        clientID: state.clientID,
        "color-rendering": "optimizeQuality",
        id: `cvat_canvas_shape_${state.clientID}`,
        "shape-rendering": "geometricprecision",
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "data-z-order": state.zOrder,
        ...this.getShapeColorization(state), // 应用图形颜色配置
      })
      .addClass("cvat_canvas_shape");

    // 如果图形被遮挡，添加遮挡样式
    if (state.occluded) {
      polygon.addClass("cvat_canvas_shape_occluded");
    }

    // 如果图形被隐藏、在画布外或内部隐藏，添加隐藏样式
    if (state.hidden || state.outside || this.isInnerHidden(state.clientID)) {
      polygon.addClass("cvat_canvas_hidden");
    }

    // 如果是基准真相，添加基准真相样式
    if (state.isGroundTruth) {
      polygon.addClass("cvat_canvas_ground_truth");
    }

    return polygon;
  }

  /**
   * 添加折线到画布
   * @param points - 折线顶点坐标字符串，格式为"x1,y1 x2,y2 ..."
   * @param state - 图形状态对象，包含元素ID、遮挡状态等
   * @returns 创建的SVG折线元素
   */
  private addPolyline(points: string, state: any): SVG.PolyLine {
    // 创建折线元素并设置基本属性
    const polyline = this.adoptedContent
      .polyline(points)
      .attr({
        clientID: state.clientID,
        "color-rendering": "optimizeQuality",
        id: `cvat_canvas_shape_${state.clientID}`,
        "shape-rendering": "geometricprecision",
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "data-z-order": state.zOrder,
        ...this.getShapeColorization(state), // 应用图形颜色配置
      })
      .addClass("cvat_canvas_shape");

    // 如果图形被遮挡，添加遮挡样式
    if (state.occluded) {
      polyline.addClass("cvat_canvas_shape_occluded");
    }

    // 如果图形被隐藏、在画布外或内部隐藏，添加隐藏样式
    if (state.hidden || state.outside || this.isInnerHidden(state.clientID)) {
      polyline.addClass("cvat_canvas_hidden");
    }

    // 如果是基准真相，添加基准真相样式
    if (state.isGroundTruth) {
      polyline.addClass("cvat_canvas_ground_truth");
    }

    return polyline;
  }

  /**
   * 添加点集到画布
   * @param points - 点集坐标字符串，格式为"x1,y1 x2,y2 ..."
   * @param state - 图形状态对象，包含元素ID、遮挡状态等
   * @returns 创建的SVG折线元素
   */
  private addPoints(points: string, state: any): SVG.PolyLine {
    // 创建折线元素并设置基本属性（设置为不可见，仅用于点集的交互）
    const shape = this.adoptedContent
      .polyline(points)
      .attr({
        "color-rendering": "optimizeQuality",
        "pointer-events": "none",
        "shape-rendering": "geometricprecision",
        "stroke-width": 0,
        ...this.getShapeColorization(state),
      })
      .style({
        opacity: 0,
      });

    // 设置点集的交互功能
    const group = this.setupPoints(shape, state);

    // 如果点集被隐藏、在画布外或内部隐藏，添加隐藏样式
    if (state.hidden || state.outside || this.isInnerHidden(state.clientID)) {
      group.addClass("cvat_canvas_hidden");
    }

    // 如果点集被遮挡，添加遮挡样式
    if (state.occluded) {
      group.addClass("cvat_canvas_shape_occluded");
    }

    // 如果是基准真相，添加基准真相样式
    if (state.isGroundTruth) {
      group.addClass("cvat_canvas_ground_truth");
    }

    // 重写移除方法，确保在选择状态下正确移除
    shape.remove = (): SVG.PolyLine => {
      this.selectize(false, shape);
      shape.constructor.prototype.remove.call(shape);
      return shape;
    };

    return shape;
  }

  /**
   * 添加椭圆到画布
   * @param points - 椭圆参数字符串，包含中心点坐标和边界点坐标
   * @param state - 图形状态对象，包含元素ID、旋转角度、遮挡状态等
   * @returns 创建的SVG椭圆元素
   */
  private addEllipse(points: string, state: any): SVG.Rect {
    // 解析椭圆参数：中心点坐标(cx, cy)和右边界点(rightX)、上边界点(topY)
    const [cx, cy, rightX, topY] = points.split(/[/,\s]/g).map((coord) => +coord);
    // 计算椭圆的半径：水平半径(rx)和垂直半径(ry)
    const [rx, ry] = [rightX - cx, cy - topY];

    // 创建椭圆元素并设置基本属性
    const rect = this.adoptedContent
      .ellipse(rx * 2, ry * 2)
      .attr({
        clientID: state.clientID,
        "color-rendering": "optimizeQuality",
        id: `cvat_canvas_shape_${state.clientID}`,
        "shape-rendering": "geometricprecision",
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        "data-z-order": state.zOrder,
        ...this.getShapeColorization(state),
      })
      .center(cx, cy)
      .addClass("cvat_canvas_shape");

    // 如果有旋转角度，应用旋转
    if (state.rotation) {
      rect.rotate(state.rotation);
    }

    // 如果椭圆被遮挡，添加遮挡样式
    if (state.occluded) {
      rect.addClass("cvat_canvas_shape_occluded");
    }

    // 如果椭圆被隐藏、在画布外或内部隐藏，添加隐藏样式
    if (state.hidden || state.outside || this.isInnerHidden(state.clientID)) {
      rect.addClass("cvat_canvas_hidden");
    }

    // 如果是基准真相，添加基准真相样式
    if (state.isGroundTruth) {
      rect.addClass("cvat_canvas_ground_truth");
    }

    return rect;
  }

  /**
   * 添加文本元素到画布
   * @param state - 图形状态对象，包含标签、属性、描述等信息
   * @param options - 可选参数，包含自定义文本内容
   * @returns 创建的SVG文本元素
   */
  private addText(state: any, options: { textContent?: string } = {}): SVG.Text {
    const { undefinedAttrValue } = this.configuration;
    const content = options.textContent || this.configuration.textContent;
    const withID = content!.includes("id");
    const withAttr = content!.includes("attributes");
    const withLabel = content!.includes("label");
    const withSource = content!.includes("source");
    const withDescriptions = content!.includes("descriptions");
    const withDimensions = content!.includes("dimensions");
    const textFontSize = this.configuration.textFontSize || 12;
    const { label, clientID, attributes, source, descriptions } = state;

    // 创建属性名称映射表，用于快速查找属性ID对应的名称
    const attrNames = Object.fromEntries(
      state.label.attributes.map((attr: any) => [attr.id, attr.name])
    );

    // 如果是骨架类型，需要为每个子元素添加文本
    if (state.shapeType === "skeleton") {
      state.elements.forEach((element: any) => {
        if (!(element.clientID in this.svgTexts)) {
          this.svgTexts[element.clientID] = this.addText(element, {
            textContent:
              [...(withLabel ? ["label"] : []), ...(withAttr ? ["attributes"] : [])].join(
                ","
              ) || " ",
          });
        }
      });
    }

    // 创建主文本元素，根据配置显示不同信息
    this.svgTexts[state.clientID] = this.adoptedText
      .text((block): void => {
        // 添加标签、ID和来源信息（大写显示）
        block
          .tspan(
            `${withLabel ? label.name : ""} ` +
              `${withID ? clientID : ""} ` +
              `${withSource ? `(${source})` : ""}`
          )
          .style({
            "text-transform": "uppercase",
          });

        // 为矩形和椭圆添加尺寸信息
        if (withDimensions && ["rectangle", "ellipse"].includes(state.shapeType)) {
          let width = state.points[2] - state.points[0];
          let height = state.points[3] - state.points[1];

          // 椭圆的特殊处理：宽度乘以2，高度取反乘以2
          if (state.shapeType === "ellipse") {
            width *= 2;
            height *= -2;
          }

          block
            .tspan(composeShapeDimensions(width, height, state.rotation))
            .attr({
              dy: "1.25em",
              x: 0,
            })
            .addClass("cvat_canvas_text_dimensions");
        }

        // 添加描述信息
        if (withDescriptions) {
          descriptions.forEach((desc: string, idx: number) => {
            block
              .tspan(`${desc}`)
              .attr({
                dy: idx === 0 ? "1.25em" : "1em",
                x: 0,
              })
              .addClass("cvat_canvas_text_description");
          });
        }

        // 添加属性信息
        if (withAttr) {
          Object.keys(attributes).forEach((attrID: string, idx: number) => {
            const values = `${
              attributes[attrID] === undefinedAttrValue ? "" : attributes[attrID]
            }`.split("\n");
            const parent = block
              .tspan(`${attrNames[attrID]}: `)
              .attr({ attrID, dy: idx === 0 ? "1.25em" : "1em", x: 0 })
              .addClass("cvat_canvas_text_attribute");
            values.forEach((attrLine: string, index: number) => {
              parent.tspan(attrLine).attr({
                dy: index === 0 ? 0 : "1em",
              });
            });
          });
        }
      })
      .move(0, 0)
      .attr({ "data-client-id": state.clientID })
      .style({ "font-size": textFontSize })
      .addClass("cvat_canvas_text");

    return this.svgTexts[state.clientID];
  }

  /**
   * 显示方向指示器方法
   * 为多边形或多段线添加方向指示器箭头，显示绘制方向
   * @param state - 对象状态，包含点坐标和图形类型
   * @param shape - SVG多边形或多段线元素
   */
  private showDirection(state: any, shape: SVG.Polygon | SVG.PolyLine): void {
    // 获取箭头路径常量
    const path = consts.ARROW_PATH;

    // 解析点坐标
    const points = parsePoints(state.points);
    const handler = shape.remember("_selectHandler");

    if (!handler || !handler.nested) return;
    // 获取前两个控制点
    const firstCircle = handler.nested.children()[0];
    const secondCircle = handler.nested.children()[1];
    // 标记第一个点为特殊样式
    firstCircle.addClass("cvat_canvas_first_poly_point");

    // 计算箭头位置（前两个点的中点）
    const [cx, cy] = [
      (secondCircle.cx() + firstCircle.cx()) / 2,
      (secondCircle.cy() + firstCircle.cy()) / 2,
    ];
    // 获取前两个点坐标
    const [firstPoint, secondPoint] = points.slice(0, 2);
    // 定义X轴单位向量
    const xAxis = { i: 1, j: 0 };
    // 计算从前一点到后一点的向量
    const baseVector = {
      i: secondPoint.x - firstPoint.x,
      j: secondPoint.y - firstPoint.y,
    };
    const baseVectorLength = vectorLength(baseVector);
    let cosinus = 0;

    // 计算向量夹角余弦值
    if (baseVectorLength !== 0) {
      // 两点坐标相同
      cosinus =
        scalarProduct(xAxis, baseVector) / (vectorLength(xAxis) * baseVectorLength);
    }
    // 计算旋转角度
    const angle = (Math.acos(cosinus) * (Math.sign(baseVector.j) || 1) * 180) / Math.PI;

    // 创建箭头路径元素
    const pathElement = handler.nested
      .path(path)
      .fill("white")
      .stroke({
        width: 1,
        color: "black",
      })
      .addClass("cvat_canvas_poly_direction")
      .style({
        "transform-origin": `${cx}px ${cy}px`,
        transform: `scale(${1 / this.geometry.scale}) rotate(${angle}deg)`,
      })
      .move(cx, cy);

    // 添加点击事件处理，点击箭头反转点顺序
    pathElement.on("click", (e: MouseEvent): void => {
      if (e.button === 0) {
        e.stopPropagation();
        if (state.shapeType === "polygon") {
          // 多边形：保持第一个点不变，反转其余点
          const reversedPoints = [points[0], ...points.slice(1).reverse()];
          this.onEditDone(state, pointsToNumberArray(reversedPoints));
        } else {
          // 多段线：反转所有点
          const reversedPoints = points.reverse();
          this.onEditDone(state, pointsToNumberArray(reversedPoints));
        }
      }
    });

    // 保存角度数据并调整箭头位置
    pathElement.data("angle", angle);
    pathElement.dmove(-pathElement.width() / 2, -pathElement.height() / 2);
  }

  /**
   * 隐藏方向指示器方法
   * 隐藏多边形或多段线的方向指示器箭头
   * @param shape - SVG多边形或多段线元素
   */
  private hideDirection(shape: SVG.Polygon | SVG.PolyLine): void {
    /* eslint class-methods-use-this: 0 */
    // 获取图形的选择处理器
    const handler = shape.remember("_selectHandler");
    if (!handler || !handler.nested) return;
    const nested = handler.nested as SVG.Parent;
    // 移除第一个点的特殊样式
    if (nested.children().length) {
      nested.children()[0].removeClass("cvat_canvas_first_poly_point");
    }

    // 移除所有方向指示器
    const node = nested.node as SVG.LinkedHTMLElement;
    const directions = node.getElementsByClassName("cvat_canvas_poly_direction");
    for (const direction of directions) {
      const { instance } = direction as any;
      instance.off("click");
      instance.remove();
    }
  }

  /**
   * 将SVG坐标转换为画布坐标
   * @param {number[]} point - SVG坐标点[x, y]
   * @returns {number[]} 转换后的画布坐标点
   */
  public translateFromSVG(point: number[]): number[] {
    return translateFromSVG(this.content, point);
  }

  /**
   * 获取图形的着色配置
   * 根据配置和状态确定图形的填充色、边框色和透明度
   * @param {any} state - 对象状态
   * @param {Object} opts - 可选参数，包含父状态信息
   * @param {any} opts.parentState - 父状态，用于骨架类型
   * @returns {Object} 包含fill、stroke和fill-opacity的对象
   */
  private getShapeColorization(
    state: any,
    opts: {
      parentState?: any;
    } = {}
  ): { fill: string; stroke: string; "fill-opacity": number } {
    const { shapeType } = state;
    const parentShapeType = opts.parentState?.shapeType;
    const { configuration } = this;
    const { colorBy, shapeOpacity, outlinedBorders } = configuration;
    let shapeColor = "";

    // 根据着色模式确定基础颜色
    if (colorBy === ColorBy.INSTANCE) {
      shapeColor = state.color;
    } else if (colorBy === ColorBy.GROUP) {
      shapeColor = state.group.color;
    } else if (colorBy === ColorBy.LABEL) {
      shapeColor = state.label.color;
    }

    // 处理高亮元素
    if (this.highlightedElements.elementsIDs.length) {
      if (this.highlightedElements.elementsIDs.includes(state.clientID)) {
        // 如果是高亮元素，根据严重程度设置颜色
        if (this.highlightedElements.severity === HighlightSeverity.ERROR) {
          shapeColor = consts.CONFLICT_COLOR;
        } else if (this.highlightedElements.severity === HighlightSeverity.WARNING) {
          shapeColor = consts.WARNING_COLOR;
        }
      } else {
        // 非高亮元素使用阴影色
        shapeColor = consts.SHADED_COLOR;
      }
    }

    // 确定边框颜色
    const outlinedColor =
      parentShapeType === "skeleton" ? "black" : outlinedBorders || shapeColor;

    return {
      fill: shapeColor,
      stroke: outlinedColor,
      // 线条、点和骨架类型不填充，或者作为骨架的子元素时需要填充
      "fill-opacity":
        !["polyline", "points", "skeleton"].includes(shapeType) ||
        parentShapeType === "skeleton"
          ? (shapeOpacity ?? 0)
          : 0,
    };
  }

  /**
   * 拖拽功能方法
   * 为图形添加或移除拖拽功能，支持不同图形类型的拖拽处理
   * @param state - 对象状态，包含图形类型等信息
   * @param shape - 要添加拖拽功能的SVG图形元素
   * @param onDragStart - 拖拽开始时的回调函数
   * @param onDragMove - 拖拽移动时的回调函数
   * @param onDragEnd - 拖拽结束时的回调函数
   */
  private draggable(
    state: any,
    shape: SVG.Shape,
    onDragStart: () => void = () => {},
    onDragMove: () => void = () => {},
    onDragEnd: () => void = () => {}
  ): void {
    let draggableInstance = shape;
    // 骨架类型特殊处理：使用包装矩形来拖拽整个骨架
    if (shape.classes().includes("cvat_canvas_shape_skeleton")) {
      draggableInstance = (shape as any)
        .children()
        .find((child: SVG.Element) => child.type === "rect");
    }

    if (state) {
      // 初始化拖拽相关变量
      let start = Date.now();
      let aborted = false;
      let skeletonSVGTemplate: SVG.G | null = null;
      // 添加可拖拽样式
      shape.addClass("cvat_canvas_shape_draggable");
      // 启用拖拽功能，掩码类型启用网格对齐
      (draggableInstance as any).draggable({
        ...(state.shapeType === "mask" ? { snapToGrid: 1 } : {}),
      });

      let startCenter: { x: number; y: number } | null = null;
      // 拖拽开始事件处理
      draggableInstance
        .on("dragstart", (): void => {
          onDragStart();
          this.draggableShape = shape;
          // 记录初始中心点位置
          const { cx, cy } = shape.bbox();
          startCenter = { x: cx, y: cy };
          start = Date.now();
          // 拖拽移动事件处理
        })
        .on("dragmove", (e: CustomEvent): void => {
          onDragMove();
          // 骨架类型特殊处理
          if (state.shapeType === "skeleton" && e.target) {
            const { instance } = e.target as any;
            const [x, y] = [instance.x(), instance.y()];
            const prevXtl = +draggableInstance.attr("data-xtl");
            const prevYtl = +draggableInstance.attr("data-ytl");

            // 更新所有未锁定的骨架元素位置
            for (const child of (shape as SVG.G).children()) {
              if (child.type === "circle") {
                const childClientID = child.attr("data-client-id");
                if (
                  state.elements.find((el: any) => el.clientID === childClientID).lock ||
                  false
                ) {
                  continue;
                }
                child.center(child.cx() - prevXtl + x, child.cy() - prevYtl + y);
              }
            }

            // 更新包装矩形的位置数据
            draggableInstance.attr("data-xtl", x);
            draggableInstance.attr("data-ytl", y);
            draggableInstance.attr("data-xbr", x + instance.width());
            draggableInstance.attr("data-ybr", y + instance.height());

            // 更新骨架连接线
            skeletonSVGTemplate =
              skeletonSVGTemplate ?? makeSVGFromTemplate(state.label.structure.svg);
            setupSkeletonEdges(shape as SVG.G, skeletonSVGTemplate);
          }
          // 拖拽结束事件处理
        })
        .on("dragend", (): void => {
          // 如果拖拽被中止，重置视图位置
          if (aborted) {
            this.resetViewPosition(state.clientID);
            return;
          }

          onDragEnd();
          this.draggableShape = null;
          const { cx, cy } = shape.bbox();

          // 计算移动距离
          const dx2 = (startCenter!.x - cx) ** 2;
          const dy2 = (startCenter!.y - cy) ** 2;
          // 只有实际移动了才更新状态
          if (Math.sqrt(dx2 + dy2) > 0) {
            // 掩码类型特殊处理
            if (state.shapeType === "mask") {
              const { points } = state;
              const x = Math.trunc(shape.x()) - this.geometry.offset;
              const y = Math.trunc(shape.y()) - this.geometry.offset;
              points.splice(-4);
              points.push(x, y, x + shape.width() - 1, y + shape.height() - 1);
              this.onEditDone(state, points);
              // 骨架类型特殊处理
            } else if (state.shapeType === "skeleton") {
              const points: number[] = [];
              // 收集所有骨架元素点坐标
              state.elements.forEach((element: any) => {
                const elementShape = (shape as SVG.G)
                  .children()
                  .find(
                    (child: SVG.Shape) =>
                      child.id() === `cvat_canvas_shape_${element.clientID}`
                  );

                if (elementShape) {
                  points.push(
                    ...this.translateFromCanvas(readPointsFromShape(elementShape))
                  );
                }
              });
              this.onEditDone(state, points);
            } else {
              // 获取图形点坐标，考虑可能的旋转变换
              let points = readPointsFromShape(shape);
              const { rotation } = shape.transform();
              if (rotation) {
                points = this.translatePointsFromRotatedShape(shape, points);
              }

              this.onEditDone(state, this.translateFromCanvas(points));
            }

            // 分发拖拽图形事件
            this.canvas.dispatchEvent(
              new CustomEvent("canvas.dragshape", {
                bubbles: false,
                cancelable: true,
                detail: {
                  state,
                  duration: Date.now() - start,
                },
              })
            );
          }
          // 拖拽中止事件处理
        })
        .on("dragabort", (): void => {
          onDragEnd();
          this.draggableShape = null;
          aborted = true;
          // 禁用SVG.js内部拖拽事件
          // 调用链：(mouseup -> SVG.handler.end -> SVG.handler.drag -> dragend)
          window.dispatchEvent(new MouseEvent("mouseup"));
        });
    } else {
      // 移除可拖拽样式
      shape.removeClass("cvat_canvas_shape_draggable");

      // 如果当前图形正在被拖拽，触发拖拽中止事件
      if (this.draggableShape === shape) {
        draggableInstance.fire("dragabort");
      }

      // 移除所有拖拽事件监听器
      draggableInstance.off("dragstart");
      draggableInstance.off("dragmove");
      draggableInstance.off("dragend");
      draggableInstance.off("dragabort");
      // 禁用拖拽功能
      (draggableInstance as any).draggable(false);
    }
  }

  /**
   * 取消激活图形
   * 将当前激活的图形恢复到非激活状态，移除交互功能并恢复默认样式
   */
  private deactivateShape(): void {
    if (this.activeElement.clientID) {
      const { displayAllText } = this.configuration;
      const { clientID } = this.activeElement;
      // 获取已绘制的状态和图形元素
      const drawnState = this.drawnStates[clientID];
      const shape = this.svgShapes[clientID];

      // 移除激活状态的CSS类
      if (drawnState.shapeType === "points") {
        this.svgShapes[clientID]
          .remember("_selectHandler")
          .nested.removeClass("cvat_canvas_shape_activated");
      } else {
        shape.removeClass("cvat_canvas_shape_activated");
      }

      // 恢复图形的透明度
      if (drawnState.shapeType === "mask") {
        shape.attr("opacity", `${Math.sqrt(this.configuration.shapeOpacity!)}`);
      } else {
        shape.attr("fill-opacity", `${this.configuration.shapeOpacity}`);
      }

      // 如果图形未固定，禁用拖拽功能
      if (!drawnState.pinned) {
        // 注意：骨架类型的resizable内部使用了draggable，所以必须先禁用draggable
        this.draggable(null, shape);
      }

      // 禁用调整大小功能（遮罩类型除外）
      if (drawnState.shapeType !== "mask") {
        this.resizable(null, shape);
      } else {
        // 移除遮罩的双击事件监听器
        (shape as any).off("dblclick");
      }

      // 禁用选择功能（点类型除外）
      if (drawnState.shapeType !== "points") {
        this.selectize(false, shape);
      }

      // 如果是立方体，隐藏投影
      if (drawnState.shapeType === "cuboid") {
        (shape as any).attr("projections", false);
      }

      // TODO: 只有在设置中隐藏文本时才隐藏文本
      // 如果配置不显示所有文本，删除文本元素
      const text = this.svgTexts[clientID];
      if (text && !displayAllText) {
        this.deleteText(clientID);
      }

      // 重新排序对象
      this.sortObjects();

      // 清除激活的图形ID
      this.activeElement = {
        ...this.activeElement,
        clientID: null,
      };
    }
  }

  /**
   * 根据Z轴顺序排序画布上的对象
   * 确保对象按照正确的层级顺序显示，并将十字准线和交互点置于最顶层
   */
  private sortObjects(): void {
    // TODO: 可以显著优化此方法
    // 获取所有图形元素及其Z轴顺序
    const states = Array.from(
      this.content.getElementsByClassName("cvat_canvas_shape")
    ).map((value: Element): [SVGElement, number] => {
      const state = value as SVGElement;
      return [state, +state.getAttribute("data-z-order")!];
    });

    // 获取所有十字准线并移到内容区域的最后（最顶层）
    const crosshair = Array.from(
      this.content.getElementsByClassName("cvat_canvas_crosshair")
    );
    crosshair.forEach((value: Element): void => {
      const line = value as SVGLineElement;
      return this.content.append(line);
    });
    // 获取所有交互点并移到内容区域的最后（最顶层）
    const interaction = Array.from(
      this.content.getElementsByClassName("cvat_interaction_point")
    );
    interaction.forEach((value: Element): void => {
      const circle = value as SVGCircleElement;
      return this.content.append(circle);
    });

    // 检查是否需要排序（如果所有对象的Z轴顺序相同则不需要排序）
    const needSort = states.some((pair): boolean => pair[1] !== states[0][1]);
    if (!states.length || !needSort) {
      return;
    }

    // 按Z轴顺序排序
    const sorted = states.sort((a, b): number => a[1] - b[1]);
    // 将排序后的元素添加到内容区域
    sorted.forEach((pair): void => {
      this.content.appendChild(pair[0]);
    });

    // 将排序后的元素移到内容区域的前面（底层）
    this.content.prepend(...sorted.map((pair): SVGElement => pair[0]));
  }

  /**
   * 删除文本元素
   * 从画布中移除指定元素ID的文本元素
   * @param {number} clientID - 要删除文本的元素ID
   */
  private deleteText(clientID: number): void {
    // 删除主文本元素
    if (clientID in this.svgTexts) {
      this.svgTexts[clientID].remove();
      delete this.svgTexts[clientID];
    }

    // 如果是骨架类型，递归删除所有子元素的文本
    if (
      clientID in this.drawnStates &&
      this.drawnStates[clientID].shapeType === "skeleton" &&
      this.drawnStates[clientID].elements !== null
    ) {
      this.drawnStates[clientID].elements.forEach((element) => {
        this.deleteText(element.clientID);
      });
    }
  }

  /**
   * 调整大小功能方法
   * 为图形添加或移除调整大小功能，支持不同图形类型的调整大小处理
   * @param state - 对象状态，包含图形类型等信息
   * @param shape - 要添加调整大小功能的SVG图形元素
   * @param onResizeStart - 调整大小开始时的回调函数
   * @param onResizing - 调整大小过程中的回调函数
   * @param onResizeEnd - 调整大小结束时的回调函数
   */
  private resizable(
    state: any,
    shape: SVG.Shape,
    onResizeStart: () => void = () => {},
    onResizing: () => void = () => {},
    onResizeEnd: () => void = () => {}
  ): void {
    let resizableInstance = shape;
    let skeletonSVGTemplate: SVG.G | null = null;

    // 骨架类型特殊处理：使用包装矩形来调整整个骨架大小
    if (shape.classes().includes("cvat_canvas_shape_skeleton")) {
      resizableInstance = (shape as any)
        .children()
        .find((child: SVG.Element) => child.type === "rect");

      // 获取所有骨架元素圆点
      const circles = (shape as any)
        .children()
        .filter((child: SVG.Element) => child.type === "circle");
      const svgElements = Object.fromEntries(
        circles.map((circle: SVG.Circle) => [circle.attr("data-client-id"), circle])
      );

      // 为每个骨架元素添加拖拽功能
      Object.entries(svgElements).forEach(([key, element]) => {
        if (state) {
          const clientID = +key;
          const elementState = state.elements.find(
            (_element: any) => _element.clientID === clientID
          );
          const text = this.svgTexts[clientID];
          // 隐藏元素文本函数
          const hideElementText = (): void => {
            if (text) {
              text.addClass("cvat_canvas_hidden");
            }
          };

          // 显示元素文本函数
          const showElementText = (): void => {
            if (text) {
              text.removeClass("cvat_canvas_hidden");
              this.updateTextPosition(text);
            }
          };

          // 只有未锁定的元素才可拖拽
          if (!elementState.lock) {
            this.draggable(
              elementState,
              element,
              () => {
                this.mode = Mode.DRAG;
                hideElementText();
              },
              () => {
                skeletonSVGTemplate =
                  skeletonSVGTemplate ?? makeSVGFromTemplate(state.label.structure.svg);
                setupSkeletonEdges(shape as SVG.G, skeletonSVGTemplate);
              },
              () => {
                this.mode = Mode.IDLE;
                showElementText();
              }
            );
          }
        } else {
          this.draggable(null, element);
        }
      });
    }

    if (state) {
      // 初始化调整大小相关变量
      let resized = false;
      let aborted = false;
      let start = Date.now();

      // 启用调整大小功能
      (resizableInstance as any)
        .resize({
          snapToGrid: 0.1,
          snapToAngle: this.snapToAngleResize,
        })
        // 调整大小开始事件处理
        .on("resizestart", (): void => {
          onResizeStart();
          resized = false;
          start = Date.now();
          this.resizableShape = shape;
        })
        // 调整大小过程中事件处理
        .on("resizing", (e: CustomEvent): void => {
          resized = true;
          onResizing();

          // 骨架类型特殊处理
          if (state.shapeType === "skeleton" && e.target) {
            const { instance } = e.target as any;

            // 旋转骨架而不是包装边界框
            const { rotation } = resizableInstance.transform();
            shape.rotate(rotation!);

            const [x, y] = [instance.x(), instance.y()];
            const prevXtl = +resizableInstance.attr("data-xtl");
            const prevYtl = +resizableInstance.attr("data-ytl");
            const prevXbr = +resizableInstance.attr("data-xbr");
            const prevYbr = +resizableInstance.attr("data-ybr");

            // 防止边界框过小
            if (prevXbr - prevXtl < 0.1) return;
            if (prevYbr - prevYtl < 0.1) return;

            // 按比例更新所有未锁定的骨架元素位置
            for (const child of (shape as SVG.G).children()) {
              if (child.type === "circle") {
                const childClientID = child.attr("data-client-id");
                if (
                  state.elements.find((el: any) => el.clientID === childClientID).lock ||
                  false
                ) {
                  continue;
                }
                const offsetX = (child.cx() - prevXtl) / (prevXbr - prevXtl);
                const offsetY = (child.cy() - prevYtl) / (prevYbr - prevYtl);
                child.center(
                  offsetX * instance.width() + x,
                  offsetY * instance.height() + y
                );
              }
            }

            // 更新包装矩形的位置数据
            resizableInstance.attr("data-xtl", x);
            resizableInstance.attr("data-ytl", y);
            resizableInstance.attr("data-xbr", x + instance.width());
            resizableInstance.attr("data-ybr", y + instance.height());

            resized = true;
            // 更新骨架连接线
            skeletonSVGTemplate =
              skeletonSVGTemplate ?? makeSVGFromTemplate(state.label.structure.svg);
            setupSkeletonEdges(shape as SVG.G, skeletonSVGTemplate);
          }
        })
        // 调整大小完成事件处理
        .on("resizedone", (): void => {
          // 如果调整大小被中止，重置视图位置
          if (aborted) {
            this.resetViewPosition(state.clientID);
            return;
          }

          onResizeEnd();
          this.resizableShape = null;

          // 确保旋转角度在[0; 360]范围内
          let rotation = getRoundedRotation(shape);
          while (rotation < 0) rotation += 360;
          rotation %= 360;

          // 只有实际调整了大小才更新状态
          if (resized) {
            // 骨架类型特殊处理
            if (state.shapeType === "skeleton") {
              if (rotation) {
                this.onEditDone(state, state.points, rotation);
              } else {
                const points: number[] = [];
                // 收集所有骨架元素点坐标
                state.elements.forEach((element: any) => {
                  const elementShape = (shape as SVG.G)
                    .children()
                    .find(
                      (child: SVG.Shape) =>
                        child.id() === `cvat_canvas_shape_${element.clientID}`
                    );

                  if (elementShape) {
                    points.push(
                      ...this.translateFromCanvas(readPointsFromShape(elementShape))
                    );
                  }
                });
                this.onEditDone(state, points, 0);
              }
            } else {
              // 获取图形点坐标，考虑可能的旋转变换
              let points = readPointsFromShape(shape);
              if (rotation) {
                points = this.translatePointsFromRotatedShape(shape, points);
              }
              this.onEditDone(state, this.translateFromCanvas(points), rotation);
            }

            // 分发调整大小图形事件
            this.canvas.dispatchEvent(
              new CustomEvent("canvas.resizeshape", {
                bubbles: false,
                cancelable: true,
                detail: {
                  state,
                  duration: Date.now() - start,
                },
              })
            );
          }
          // 调整大小中止事件处理
        })
        .on("resizeabort", () => {
          onResizeEnd();
          aborted = true;
          this.resizableShape = null;
          // 禁用SVG.js内部调整大小事件
          // 调用链：(mouseup -> SVG.handler.end -> SVG.handler.resize-> resizeend)
          window.dispatchEvent(new MouseEvent("mouseup"));
        });
    } else {
      // 如果当前图形正在被调整大小，触发调整大小中止事件
      if (this.resizableShape === shape) {
        resizableInstance.fire("resizeabort");
      }

      // 移除所有调整大小事件监听器
      (shape as any).off("resizestart");
      (shape as any).off("resizing");
      (shape as any).off("resizedone");
      (shape as any).off("resizeabort");
      // 禁用调整大小功能
      (shape as any).resize("stop");
    }
  }

  /**
   * 取消激活所有元素
   * 包括属性和图形
   */
  private deactivate(): void {
    this.deactivateAttribute();
    this.deactivateShape();
  }

  /**
   * 处理编辑开始事件
   * 设置画布为编辑模式，隐藏掩码图形，分发编辑开始事件
   * @param state - 要编辑的对象状态（可选）
   */
  private onEditStart = (state?: any): void => {
    // 设置光标为十字准线
    this.canvas.style.cursor = "crosshair";
    // 取消当前激活状态
    this.deactivate();
    // 创建并分发canvas.editstart事件
    this.canvas.dispatchEvent(
      new CustomEvent("canvas.editstart", {
        bubbles: false,
        cancelable: true,
        detail: {
          state,
        },
      })
    );

    // 如果是掩码图形，隐藏它以避免编辑时的视觉干扰
    if (state && state.shapeType === "mask") {
      this.setupInnerFlags(state.clientID, "editHidden", true);
    }

    // 设置画布模式为编辑
    this.mode = Mode.EDIT;
  };

  /**
   * 处理编辑完成事件
   * 更新对象状态，恢复隐藏对象，分发编辑完成事件
   * @param state - 被编辑的对象状态
   * @param points - 编辑后的点坐标
   * @param rotation - 旋转角度（可选）
   */
  private onEditDone = (state: any, points: number[], rotation?: number): void => {
    // 重置光标和模式
    this.canvas.style.cursor = "";
    this.mode = Mode.IDLE;

    if (state && points) {
      // 我们需要存储"updated"标志并将"points"设置为空数组
      // 因为这些信息用于在画布对象设置期间定义diff逻辑中的"更新"对象
      // 如果由于任何原因更新在某处被拒绝，我们必须在此逻辑内重置视图

      // 还有一个更深层次的问题：
      // 某些地方画布更新绘制视图然后发送请求，更新内部CVAT状态（例如拖动、调整大小）
      // 然而，某些地方它只是发送请求来更新内部CVAT状态（例如删除点、编辑多边形/折线）
      // 如果对象视图没有被画布更改并且点按原样接受而没有任何更改
      // 如果我们只是在这里按原样设置点，那么在对象设置期间视图将不会更新
      // 这就是为什么我们需要将点设置为空数组（通常不能从CVAT得到的东西）
      // 我认为现在不能轻易修复，但未来我们应该重构代码

      // 处理子对象（如骨架结构的子元素）
      if (Number.isInteger(state.parentID)) {
        const { elements } = this.drawnStates[state.parentID];
        const drawnElement = elements!.find((el) => el.clientID === state.clientID);
        drawnElement!.updated = 0;
        drawnElement!.points = [];

        this.drawnStates[state.parentID].updated = 0;
        this.drawnStates[state.parentID].points = [];
      } else {
        // 处理普通对象
        this.drawnStates[state.clientID].updated = 0;
        this.drawnStates[state.clientID].points = [];
      }

      // 创建并分发canvas.edited事件
      const event: CustomEvent = new CustomEvent("canvas.edited", {
        bubbles: false,
        cancelable: true,
        detail: {
          state,
          points,
          rotation: typeof rotation === "number" ? rotation : state.rotation,
        },
      });

      this.canvas.dispatchEvent(event);
    } else {
      this.dispatchCanceledEvent();
    }

    // 恢复所有因编辑而隐藏的对象
    for (const clientID of Object.keys(this.innerObjectsFlags.editHidden)) {
      this.setupInnerFlags(+clientID, "editHidden", false);
    }
  };

  /**
   * 变换画布方法
   * 根据当前几何参数（缩放、旋转）更新所有画布元素和图形的变换
   */
  private transformCanvas(): void {
    // 变换画布基础元素
    for (const obj of [
      this.background,
      this.videoElement,
      this.content,
      this.attachmentBoard,
    ]) {
      obj.style.transform = `scale(${this.geometry.scale}) rotate(${this.geometry.angle}deg)`;
    }

    // 变换所有图形控制点
    for (const element of [
      ...window.document.getElementsByClassName("svg_select_points"),
      ...window.document.getElementsByClassName("svg_select_points_rot"),
      ...window.document.getElementsByClassName("svg_select_boundingRect"),
    ]) {
      element.setAttribute(
        "stroke-width",
        `${consts.POINTS_STROKE_WIDTH / this.geometry.scale}`
      );
      element.setAttribute(
        "r",
        `${this.configuration.controlPointsSize! / this.geometry.scale}`
      );
    }

    // 变换多边形方向指示器
    for (const element of window.document.getElementsByClassName(
      "cvat_canvas_poly_direction"
    )) {
      const angle = (element as any).instance.data("angle");

      (element as any).instance.style({
        transform: `scale(${1 / this.geometry.scale}) rotate(${angle}deg)`,
      });
    }

    // 高亮选中的控制点
    for (const element of window.document.getElementsByClassName(
      "cvat_canvas_selected_point"
    )) {
      const previousWidth = element.getAttribute("stroke-width") as string;
      element.setAttribute("stroke-width", `${+previousWidth * 2}`);
    }

    // 变换所有绘制的图形和文本
    for (const key of Object.keys(this.svgShapes)) {
      const clientID = +key;
      const object = this.svgShapes[clientID];
      object.attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
      });
      if (object.type === "circle") {
        object.attr(
          "r",
          `${this.configuration.controlPointsSize! / this.geometry.scale}`
        );
      }
      if (clientID in this.svgTexts) {
        this.updateTextPosition(this.svgTexts[clientID]);
      }
    }

    // 变换骨架边缘
    for (const skeletonEdge of window.document.getElementsByClassName(
      "cvat_canvas_skeleton_edge"
    )) {
      skeletonEdge.setAttribute(
        "stroke-width",
        `${consts.BASE_STROKE_WIDTH / this.geometry.scale}`
      );
    }

    // 变换所有处理器
    this.drawHandler.transform(this.geometry);
    this.masksHandler.transform(this.geometry);
    this.editHandler.transform(this.geometry);
    this.zoomHandler.transform(this.geometry);
    this.autoborderHandler.transform(this.geometry);
    this.interactionHandler.transform(this.geometry);
    this.regionSelector.transform(this.geometry);
  }

  /**
   * 聚焦到指定区域方法
   * 调整画布缩放和位置，使指定区域位于画布中心并尽可能放大
   * @param x - 区域左上角X坐标
   * @param y - 区域左上角Y坐标
   * @param width - 区域宽度
   * @param height - 区域高度
   */
  private onFocusRegion = (x: number, y: number, width: number, height: number): void => {
    // 首先计算并应用缩放比例
    let scale = null;

    // 根据画布旋转角度计算缩放比例
    if ((this.geometry.angle / 90) % 2) {
      // 90度、270度等旋转角度
      scale = Math.min(
        Math.max(
          Math.min(
            this.geometry.canvas.width / height,
            this.geometry.canvas.height / width
          ),
          FrameZoom.MIN
        ),
        FrameZoom.MAX
      );
    } else {
      // 0度、180度等旋转角度
      scale = Math.min(
        Math.max(
          Math.min(
            this.geometry.canvas.width / width,
            this.geometry.canvas.height / height
          ),
          FrameZoom.MIN
        ),
        FrameZoom.MAX
      );
    }

    // 应用新的缩放比例
    this.geometry = { ...this.geometry, scale };
    this.transformCanvas();

    // 计算区域中心点在画布中的坐标
    const [canvasX, canvasY] = translateFromSVG(this.content, [
      x + width / 2,
      y + height / 2,
    ]);

    // 获取画布在屏幕中的位置
    const canvasOffset = this.canvas.getBoundingClientRect();
    // 计算画布中心点在屏幕中的坐标
    const [cx, cy] = [
      this.canvas.clientWidth / 2 + canvasOffset.left,
      this.canvas.clientHeight / 2 + canvasOffset.top,
    ];

    // 计算拖动后的几何参数，使区域中心与画布中心对齐
    const dragged = {
      ...this.geometry,
      top: this.geometry.top + cy - canvasY,
      left: this.geometry.left + cx - canvasX,
      scale,
    };

    // 更新控制器和自身的几何参数
    this.controller.geometry = dragged;
    this.geometry = dragged;
    // 移动画布到新位置
    this.moveCanvas();
  };

  /**
   * 移动画布方法
   * 根据当前几何参数更新所有画布元素的位置
   */
  private moveCanvas(): void {
    // 更新背景的位置
    for (const obj of [this.background, this.videoElement]) {
      obj.style.top = `${this.geometry.top}px`;
      obj.style.left = `${this.geometry.left}px`;
    }

    // 更新内容、文本和附件板的位置（考虑偏移量）
    for (const obj of [this.content, this.text, this.attachmentBoard]) {
      obj.style.top = `${this.geometry.top - this.geometry.offset}px`;
      obj.style.left = `${this.geometry.left - this.geometry.offset}px`;
    }

    // 更新所有处理器的变换
    this.regionSelector.transform(this.geometry);
    this.objectSelector.transform(this.geometry);
    this.drawHandler.transform(this.geometry);
    this.masksHandler.transform(this.geometry);
    this.editHandler.transform(this.geometry);
    this.zoomHandler.transform(this.geometry);
    this.autoborderHandler.transform(this.geometry);
    this.interactionHandler.transform(this.geometry);
    this.sliceHandler.transform(this.geometry);
  }

  /**
   * 调整画布大小方法
   * 根据图像尺寸和偏移量调整所有画布元素的大小
   */
  private resizeCanvas(): void {
    // 调整背景、掩码内容的大小为图像尺寸
    for (const obj of [this.background, this.videoElement, this.masksContent]) {
      obj.style.width = `${this.geometry.image.width}px`;
      obj.style.height = `${this.geometry.image.height}px`;
    }

    // 调整内容、文本和附件板的大小为图像尺寸加上两倍偏移量
    for (const obj of [this.content, this.text, this.attachmentBoard]) {
      obj.style.width = `${this.geometry.image.width + this.geometry.offset * 2}px`;
      obj.style.height = `${this.geometry.image.height + this.geometry.offset * 2}px`;
    }
  }
}
