import type * as SVG from "svg.js";

import consts from "../consts/consts";
import type { CanvasHint, Configuration, Geometry, SliceData } from "../core/canvasModel";
import type { ObjectSelector } from "../selector/objectSelector";
import {
  findClosestPointOnSegment,
  findIntersection,
  type Segment,
  segmentsFromPoints,
  stringifyPoints,
  toReversed,
  translateFromCanvas,
  translateToCanvas,
  translateToSVG,
  zipChannels,
} from "../utils/shared";

/**
 * 切片处理器接口
 * 定义了处理图像切片操作的基本方法
 */
export interface SliceHandler {
  /**
   * 执行切片操作
   * @param sliceData - 切片数据，包含切片的相关信息
   */
  slice(sliceData: any): void;

  /**
   * 应用几何变换
   * @param geometry - 几何变换对象，定义要应用的变换
   */
  transform(geometry: Geometry): void;

  /**
   * 配置切片处理器
   * @param config - 配置对象，包含处理器的设置参数
   */
  configure(config: Configuration): void;

  /**
   * 取消当前操作
   */
  cancel(): void;
}

/**
 * 增强的切片数据类型
 * 包含切片操作所需的完整信息
 */
type EnhancedSliceData = {
  /** 是否启用切片 */
  enabled: boolean;
  /** 轮廓点数组，格式为 [x1, y1, x2, y2, ...] */
  contour: number[];
  /** 切片状态信息 */
  state: any;
  /** 形状类型，可以是'mask'或'polygon' */
  shapeType: "mask" | "polygon";
};

/**
 * 在离屏画布上绘制图像
 * 将图像绘制到离屏画布上，设置黑色背景和标准合成模式
 * @param context - 离屏画布的2D渲染上下文
 * @param image - 要绘制的图像源
 */
function drawOverOffscreenCanvas(
  context: OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource
): void {
  // 设置填充颜色为黑色
  context.fillStyle = "black";
  // 设置全局合成操作为标准覆盖模式
  context.globalCompositeOperation = "source-over";
  // 在画布上绘制图像，位置为(0,0)
  context.drawImage(image, 0, 0);
}

/**
 * 在离屏画布上应用多边形遮罩
 * 使用多边形路径作为遮罩，只保留多边形内部的图像内容
 * @param context - 离屏画布的2D渲染上下文
 * @param polygon - 多边形点数组，格式为 [x1, y1, x2, y2, ...]
 */
function applyOffscreenCanvasMask(
  context: OffscreenCanvasRenderingContext2D,
  polygon: number[]
): void {
  // 保存当前合成操作模式
  const currentCompositeOperation = context.globalCompositeOperation;
  // 设置合成操作为'destination-in'，只保留新绘制内容与现有内容重叠的部分
  context.globalCompositeOperation = "destination-in";
  // 开始新的路径
  context.beginPath();
  // 移动到多边形的第一个点
  context.moveTo(polygon[0], polygon[1]);
  // 遍历多边形点数组，绘制路径
  polygon.forEach((_, idx) => {
    // 只处理x坐标（偶数索引），跳过第一个点（已经在moveTo中处理）
    if (idx > 1 && !(idx % 2)) {
      // 从当前点绘制线段到下一个点
      context.lineTo(polygon[idx], polygon[idx + 1]);
    }
  });
  // 闭合路径
  context.closePath();
  // 填充路径，应用遮罩效果
  context.fill();
  // 恢复之前的合成操作模式
  context.globalCompositeOperation = currentCompositeOperation;
}

/**
 * 生成索引序列
 * 创建一个从起始索引到结束索引的索引序列，支持循环和双向遍历
 * @param length - 序列总长度
 * @param from - 起始索引
 * @param to - 结束索引
 * @param direction - 遍历方向，'forward'为正向，'backward'为反向
 * @returns 返回包含所有索引的数组
 */
function indexGenerator(
  length: number,
  from: number,
  to: number,
  direction: "forward" | "backward"
): number[] {
  // 初始化结果数组
  const result = [];
  // 根据方向设置步长值
  const value = direction === "forward" ? 1 : -1;

  // 验证索引范围是否有效
  if (from < 0 || from >= length || to < 0 || to >= length) {
    throw new Error("Incorrect index generator input");
  }

  // 初始化当前索引为起始索引
  let i = from;
  // 循环直到到达目标索引
  while (i !== to) {
    // 将当前索引添加到结果数组
    result.push(i);
    // 根据方向更新索引
    i += value;

    // 处理循环：如果超出范围，回到另一端
    if (i >= length) {
      i = 0;
    }

    // 处理循环：如果小于0，回到末尾
    if (i < 0) {
      i = length - 1;
    }
  }
  // 添加目标索引到结果数组
  result.push(i);
  return result;
}

/**
 * 获取线段与线段集合的所有交点
 * 计算给定线段与线段集合中每条线段的交点，并返回交点及其索引
 * @param segment - 要检查的线段
 * @param segments - 线段集合
 * @returns 返回一个对象，键为线段索引，值为交点坐标
 */
function getAllIntersections(
  segment: Segment,
  segments: Segment[]
): Record<number, [number, number]> {
  // 初始化交点记录对象
  const intersections: Record<number, [number, number]> = {};
  // 遍历线段集合中的每条线段
  for (let i = 0; i < segments.length; i++) {
    // 获取当前要检查的线段
    const checkedSegment = segments[i];
    // 计算两条线段的交点
    const intersection = findIntersection(checkedSegment, segment);
    // 如果存在交点（不为null），则记录交点及其索引
    if (intersection !== null) {
      intersections[i] = intersection;
    }
  }

  // 返回所有找到的交点
  return intersections;
}

/**
 * 切片处理器实现类
 * 实现了SliceHandler接口，提供形状切片功能，支持多边形和遮罩类型的形状切片
 * 通过交互式UI元素和事件处理，允许用户在画布上绘制切片线，将形状分割成两部分
 */
export class SliceHandlerImpl implements SliceHandler {
  /** SVG容器，用于绘制切片相关的图形元素 */
  private canvas: SVG.Container;
  /** 切片操作开始的时间戳，用于计算操作持续时间 */
  private startTimestamp: number;
  /** 控制点的大小，用于绘制交互点 */
  private controlPointSize: number;
  /** 轮廓边框的颜色样式 */
  private outlinedBorders: string;
  /** 切片处理器是否启用的标志 */
  private enabled: boolean;
  /** 形状轮廓的多边形线条，表示要切片的对象边界 */
  private shapeContour: SVG.PolyLine | null;
  /** 切片线，用户绘制的用于切割形状的线条 */
  private slicingLine: SVG.PolyLine | null;
  /** 切片点数组，表示切片线上的控制点 */
  private slicingPoints: SVG.Circle[];
  /** 隐藏对象的回调函数，用于临时隐藏不需要的对象 */
  private hideObject: (clientID: number) => void;
  /** 显示对象的回调函数，用于恢复隐藏的对象 */
  private showObject: (clientID: number) => void;
  /** 切片完成时的回调函数，传递状态、结果和持续时间 */
  private onSliceDone: (state?: any, results?: number[][], duration?: number) => void;
  /** 消息通知的回调函数，用于显示操作提示和警告 */
  private onMessage: (messages: CanvasHint[] | null, topic: string) => void;
  /** 错误处理的回调函数，用于捕获和报告异常 */
  private onError: (exception: unknown) => void;
  /** 获取当前画布上所有对象的函数 */
  private getObjects: () => any[];
  /** 几何计算工具，处理坐标转换和缩放 */
  private geometry: Geometry;
  /** 对象选择器，用于管理画布上的对象选择 */
  private objectSelector: ObjectSelector;
  /** 已隐藏对象的客户端ID列表，用于记录临时隐藏的对象 */
  private hiddenClientIDs: number[];

  /**
   * 创建SliceHandlerImpl实例
   * 初始化切片处理器，设置所有必要的回调函数和依赖项
   * @param hideObject - 隐藏对象的回调函数
   * @param showObject - 显示对象的回调函数
   * @param onSliceDone - 切片完成时的回调函数
   * @param onMessage - 消息通知的回调函数
   * @param onError - 错误处理的回调函数
   * @param getObjects - 获取当前画布上所有对象的函数
   * @param geometry - 几何计算工具，处理坐标转换和缩放
   * @param canvas - SVG容器，用于绘制切片相关的图形元素
   * @param objectSelector - 对象选择器，用于管理画布上的对象选择
   */
  public constructor(
    hideObject: SliceHandlerImpl["hideObject"],
    showObject: SliceHandlerImpl["showObject"],
    onSliceDone: SliceHandlerImpl["onSliceDone"],
    onMessage: SliceHandlerImpl["onMessage"],
    onError: SliceHandlerImpl["onError"],
    getObjects: () => any[],
    geometry: Geometry,
    canvas: SVG.Container,
    objectSelector: ObjectSelector
  ) {
    // 设置回调函数
    this.hideObject = hideObject;
    this.showObject = showObject;
    this.onSliceDone = onSliceDone;
    this.onMessage = onMessage;
    this.onError = onError;
    this.getObjects = getObjects;

    // 设置依赖项
    this.geometry = geometry;
    this.canvas = canvas;
    this.objectSelector = objectSelector;

    // 初始化状态变量
    this.enabled = false;
    this.startTimestamp = Date.now();
    this.controlPointSize = consts.BASE_POINT_SIZE;
    this.outlinedBorders = "black";

    // 初始化图形元素为空
    this.shapeContour = null;
    this.slicingPoints = [];
    this.slicingLine = null;
    this.hiddenClientIDs = [];
  }

  /**
   * 显示初始操作提示消息
   * 向用户显示如何开始切片操作的指导信息
   */
  private showInitialMessage(): void {
    // 调用消息回调函数，显示操作提示
    this.onMessage(
      [
        {
          type: "text",
          icon: "info",
          content: "Set initial point on the shape contour",
        },
        {
          type: "list",
          content: [
            "Slicing line must not intersect itself",
            "Slicing line must not intersect contour more than twice",
          ],
          className: "cvat-canvas-notification-list-warning",
        },
      ],
      "slice"
    );
  }

  /**
   * 初始化切片处理器
   * 设置切片操作所需的UI元素、事件监听器和内部状态
   * @param sliceData - 增强的切片数据，包含形状轮廓、状态和类型信息
   */
  private initialize(sliceData: EnhancedSliceData): void {
    // 显示初始操作提示消息
    this.showInitialMessage();
    // 获取当前形状的客户端ID
    const { clientID } = sliceData.state;
    // 隐藏除当前形状外的所有其他形状
    this.hiddenClientIDs = (this.canvas.select(".cvat_canvas_shape") as any).members
      .map((shape: SVG.Shape) => +shape.attr("clientID"))
      .filter((_clientID: number) => _clientID !== clientID);
    this.hiddenClientIDs.forEach((clientIDs) => {
      this.hideObject(clientIDs);
    });

    // 将轮廓坐标转换为画布坐标系
    const translatedContour = translateToCanvas(this.geometry.offset, sliceData.contour);
    // 创建形状轮廓的多边形
    this.shapeContour = this.canvas.polygon(stringifyPoints(translatedContour));
    // 设置轮廓线条样式
    this.shapeContour.attr({
      "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
    });
    this.shapeContour.attr("stroke", this.outlinedBorders);
    this.shapeContour.addClass("cvat_canvas_sliced_contour");

    // 从轮廓点创建线段数组，用于后续交点计算
    const contourSegments = segmentsFromPoints(translatedContour, true);
    // 初始化切片点数组和第一个交点索引
    let points: [number, number][] = [];
    let firstIntersectedSegmentIdx: number | null = null;

    /**
     * 过滤交点，移除过于接近线段端点的交点
     * @param segment - 要检查的线段
     * @param intersections - 交点集合
     * @returns 过滤后的交点集合
     */
    const filterIntersections = (
      segment: Segment,
      intersections: ReturnType<typeof getAllIntersections>
    ): ReturnType<typeof getAllIntersections> => {
      // 遍历所有交点
      for (const key of Object.keys(intersections)) {
        const point = intersections[key as unknown as number];
        // 计算交点到线段起点的距离
        const d1 = Math.sqrt(
          (point[0] - segment[0][0]) ** 2 + (point[1] - segment[0][1]) ** 2
        );
        // 计算交点到线段终点的距离
        const d2 = Math.sqrt(
          (point[0] - segment[0][0]) ** 2 + (point[1] - segment[0][1]) ** 2
        );

        // 如果交点过于接近端点，则忽略该交点
        // 这种情况下交点实际上就是端点本身
        if (d1 < 2e-3 || d2 < 2e-3) {
          delete intersections[key as unknown as number];
        }
      }
      return intersections;
    };

    /**
     * 处理初始点击事件，在轮廓上设置第一个切片点
     * @param event - 鼠标事件
     */
    const initialClick = (event: MouseEvent): void => {
      // 将鼠标坐标转换为SVG坐标系
      const [x, y] = translateToSVG(this.canvas.node as any as SVGSVGElement, [
        event.clientX,
        event.clientY,
      ]);
      // 初始化最短距离和最近点
      let shortestDistance = Number.MAX_SAFE_INTEGER;
      let closestPoint: [number, number] = [x, y];
      let segmentIdx = -1;
      // 遍历轮廓线段，找到距离点击位置最近的线段和点
      contourSegments.forEach((segment, idx) => {
        const point = findClosestPointOnSegment(segment, [x, y]);
        const distance = Math.sqrt((x - point[0]) ** 2 + (y - point[1]) ** 2);
        if (distance < shortestDistance) {
          closestPoint = point;
          shortestDistance = distance;
          segmentIdx = idx;
        }
      });

      // 设置点击阈值，考虑缩放比例
      const THRESHOLD = 20 / this.geometry.scale;
      // 如果点击位置在轮廓附近
      if (shortestDistance <= THRESHOLD) {
        // 添加两个相同的点作为切片线的起点和终点
        points.push([...closestPoint], [...closestPoint]);
        // 记录第一个交点所在的线段索引
        firstIntersectedSegmentIdx = segmentIdx;
        // 创建切片线
        this.slicingLine = this.canvas.polyline(stringifyPoints(points.flat()));
        this.slicingLine.addClass("cvat_canvas_slicing_line");
        this.slicingLine.attr({
          "stroke-width": consts.BASE_STROKE_WIDTH / this.geometry.scale,
        });
        this.slicingLine.attr("stroke", this.outlinedBorders);
        // 在切片点创建控制点圆圈
        const circle = this.canvas
          .circle((this.controlPointSize * 2) / this.geometry.scale)
          .center(closestPoint[0], closestPoint[1]);
        circle.attr("fill", "white");
        circle.attr("stroke-width", consts.BASE_STROKE_WIDTH / this.geometry.scale);
        this.slicingPoints.push(circle);

        // 显示下一步操作提示
        this.onMessage(
          [
            {
              type: "text",
              icon: "info",
              content:
                "Set more points within the shape contour, if necessary. Intersect contour at another point to slice",
            },
            {
              type: "list",
              content: [
                "Hold <Shift> to enable slip mode",
                "Do <Right Click> to cancel the latest point",
              ],
              className: "cvat-canvas-notification-list-shortcuts",
            },
          ],
          "slice"
        );
      }
    };

    /**
     * 处理点击事件，验证切片线并执行切片操作
     * 检查切片线是否自相交，是否与轮廓有正确的交点，然后执行切片算法
     * @param event - 鼠标事件
     */
    const click = (event: MouseEvent): void => {
      // 获取前一个点的坐标
      const [prevX, prevY] = points[points.length - 2];
      // 将鼠标坐标转换为SVG坐标系
      const [x, y] = translateToSVG(this.canvas.node as any as SVGSVGElement, [
        event.clientX,
        event.clientY,
      ]);
      // 更新最后一个点的位置
      points[points.length - 1] = [x, y];

      // 检查切片线是否自相交
      const segment = [
        [prevX, prevY],
        [x, y],
      ] as Segment;
      const slicingLineSegments = segmentsFromPoints(points.slice(0, -1).flat());
      const selfIntersections = filterIntersections(
        segment,
        getAllIntersections(segment, slicingLineSegments)
      );

      // 如果存在自相交，不允许继续
      if (Object.keys(selfIntersections).length) {
        return;
      }

      // 查找与轮廓的所有交点
      const intersections = filterIntersections(
        [
          [prevX, prevY],
          [x, y],
        ],
        getAllIntersections(
          [
            [prevX, prevY],
            [x, y],
          ],
          contourSegments
        )
      );

      const numberOfIntersections = Object.keys(intersections).length;
      // 必须只有一个交点才允许继续
      if (numberOfIntersections !== 1) {
        return;
      }

      // 找到两个交点，完成算法
      const intermediatePoints: [number, number][] = points.slice(1, -1);
      const secondIntersectedSegmentIdx = +Object.keys(intersections)[0];
      const firstIntersectionPoint = points[0];
      const secondIntersectionPoint = intersections[secondIntersectedSegmentIdx];

      let contour1 = [];
      let contour2 = [];
      // 处理交点在同一线段的情况
      if (firstIntersectedSegmentIdx === secondIntersectedSegmentIdx) {
        // 同一线段的结果：
        contour1 = [
          ...firstIntersectionPoint, // 第一个交点
          ...intermediatePoints.flat(), // 中间点
          ...secondIntersectionPoint, // 最后一个交点
        ];

        contour2 = [...contour1];
        // 获取其他轮廓点
        const otherPoints = Array(contourSegments.length)
          .fill(0)
          .map((_, idx) => {
            if (firstIntersectedSegmentIdx! + idx < contourSegments.length) {
              return firstIntersectedSegmentIdx! + idx;
            }
            return firstIntersectedSegmentIdx! + idx - contourSegments.length;
          })
          .map((idx) => contourSegments[idx][1]);

        // 计算距离以确定正确的方向
        const p1 = firstIntersectionPoint;
        const p2 = secondIntersectionPoint;
        const p = otherPoints[0];
        const d1 = Math.sqrt((p1[0] - p[0]) ** 2 + (p1[1] - p[1]) ** 2);
        const d2 = Math.sqrt((p2[0] - p[0]) ** 2 + (p2[1] - p[1]) ** 2);

        // 根据距离选择正确的路径
        if (d2 > d1) {
          contour2.push(...toReversed<[number, number]>(otherPoints).flat());
        } else {
          contour2.push(...otherPoints.flat());
        }
      } else {
        // 处理交点在不同线段的情况
        const firstSegmentIdx = Math.min(
          firstIntersectedSegmentIdx!,
          secondIntersectedSegmentIdx
        );
        const secondSegmentIdx = Math.max(
          firstIntersectedSegmentIdx!,
          secondIntersectedSegmentIdx
        );
        const firstSegmentPoint =
          firstIntersectedSegmentIdx! < secondIntersectedSegmentIdx
            ? firstIntersectionPoint
            : secondIntersectionPoint;
        const secondSegmentPoint =
          firstIntersectedSegmentIdx! < secondIntersectedSegmentIdx
            ? secondIntersectionPoint
            : firstIntersectionPoint;

        // 相交不同线段的结果：
        contour1 = [
          ...firstSegmentPoint, // 第一个交点
          // 中间点（如果交点顺序交换则反转）
          ...(firstSegmentIdx === firstIntersectedSegmentIdx
            ? intermediatePoints
            : toReversed<[number, number]>(intermediatePoints)
          ).flat(),
          // 第二个交点
          ...secondSegmentPoint,
          // 所有后续轮廓点 N, N+1, .. 直到（包括）第一个相交线段
          ...indexGenerator(
            contourSegments.length,
            secondSegmentIdx,
            firstSegmentIdx,
            "forward"
          )
            .map((idx) => contourSegments[idx][1])
            .slice(0, -1)
            .flat(),
        ];

        contour2 = [
          ...firstSegmentPoint, // 第一个交点
          // 中间点（如果交点顺序交换则反转）
          ...(firstSegmentIdx === firstIntersectedSegmentIdx
            ? intermediatePoints
            : toReversed<[number, number]>(intermediatePoints)
          ).flat(),
          ...secondSegmentPoint,
          // 所有先前轮廓点 N, N-1, .. 直到（包括）第一个相交线段
          ...indexGenerator(
            contourSegments.length,
            secondSegmentIdx,
            firstSegmentIdx,
            "backward"
          )
            .map((idx) => contourSegments[idx][0])
            .slice(0, -1)
            .flat(),
        ];
      }

      // 处理mask类型的形状
      if (sliceData.shapeType === "mask") {
        const shape = this.canvas.select(`#cvat_canvas_shape_${clientID}`).get(0).node;
        const width = +shape.getAttribute("width")!;
        const height = +shape.getAttribute("height")!;
        const left = +shape.getAttribute("x")!;
        const top = +shape.getAttribute("y")!;

        // 将轮廓坐标转换为相对于形状左上角的坐标
        const polygon1 = contour1.map((val, idx) => {
          if (idx % 2) return val - top;
          return val - left;
        });

        const polygon2 = contour2.map((val, idx) => {
          if (idx % 2) return val - top;
          return val - left;
        });

        // 创建离屏画布进行mask处理
        const offscreenCanvas = new OffscreenCanvas(width, height);
        const context = offscreenCanvas.getContext("2d");
        if (context !== null) {
          // 绘制原始形状
          drawOverOffscreenCanvas(context, shape as any as SVGImageElement);
          // 应用第一个多边形遮罩
          applyOffscreenCanvasMask(context, polygon1);
          const firstShape = zipChannels(context.getImageData(0, 0, width, height).data);
          // 重置画布
          context.reset();
          // 重新绘制原始形状
          drawOverOffscreenCanvas(context, shape as any as SVGImageElement);
          // 应用第二个多边形遮罩
          applyOffscreenCanvasMask(context, polygon2);
          const secondShape = zipChannels(context.getImageData(0, 0, width, height).data);
          // 调用切片完成回调
          this.onSliceDone(
            sliceData.state,
            [firstShape, secondShape],
            Date.now() - this.startTimestamp
          );
        }
      } else if (sliceData.shapeType === "polygon") {
        // 处理polygon类型的形状，直接返回轮廓坐标
        this.onSliceDone(
          sliceData.state,
          [
            translateFromCanvas(this.geometry.offset, contour1),
            translateFromCanvas(this.geometry.offset, contour2),
          ],
          Date.now() - this.startTimestamp
        );
      } else {
        // 不支持的形状类型，取消切片
        this.slice({ enabled: false });
      }
    };

    /**
     * 处理画布鼠标按下事件
     * 根据当前状态和鼠标位置处理不同的切片操作
     * @param event - 鼠标事件
     */
    const handleCanvasMousedown = (event: MouseEvent): void => {
      // 如果按住Alt键，不处理
      if (event.altKey) {
        return;
      }

      // 左键点击且没有点时，处理初始点击
      if (event.button === 0 && !points.length) {
        initialClick(event);
      } else if (event.button === 0 && event.target !== this.shapeContour!.node) {
        // 左键点击且不在轮廓上，处理普通点击
        click(event);
      } else if (event.button === 2) {
        // 右键点击，取消操作
        if (points.length > 2) {
          // 如果有超过2个点，移除最后一个点
          points.splice(-2, 1);
          this.slicingLine!.plot(stringifyPoints(points.flat()));
        } else if (points.length) {
          // 如果有点，重置整个切片操作
          this.slicingPoints.forEach((circle) => {
            circle.remove();
          });
          this.showInitialMessage();
          this.slicingLine!.remove();
          points = [];
          firstIntersectedSegmentIdx = null;
          this.slicingPoints = [];
          this.slicingLine = null;
        }
      }
    };

    /**
     * 处理形状轮廓上的鼠标按下事件
     * 支持在轮廓上添加点，并处理滑动模式
     * @param event - 鼠标事件
     * @param slipping - 是否启用滑动模式
     */
    const handleShapeMousedown = (event: MouseEvent, slipping = false): void => {
      // 如果有点且是左键点击且没有按Alt键
      if (points.length && event.button === 0 && !event.altKey) {
        // 将鼠标坐标转换为SVG坐标系
        const [x, y] = translateToSVG(this.canvas.node as any as SVGSVGElement, [
          event.clientX,
          event.clientY,
        ]);
        // 更新最后一个点的位置
        points[points.length - 1] = [x, y];
        this.slicingLine!.plot(stringifyPoints(points.flat()));

        // 获取前一个点，创建线段
        const [prevX, prevY] = points[points.length - 2];
        const segment = [
          [prevX, prevY],
          [x, y],
        ] as Segment;

        // 检查自相交
        const slicingLineSegments = segmentsFromPoints(points.slice(0, -1).flat());
        const selfIntersections = filterIntersections(
          segment,
          getAllIntersections(segment, slicingLineSegments)
        );

        // 如果存在自相交，不允许继续
        if (Object.keys(selfIntersections).length !== 0) {
          return;
        }

        // 查找与轮廓的所有交点
        const contourIntersection = filterIntersections(
          [
            [prevX, prevY],
            [x, y],
          ],
          getAllIntersections(
            [
              [prevX, prevY],
              [x, y],
            ],
            contourSegments
          )
        );

        const numberOfIntersections = Object.keys(contourIntersection).length;
        // 如果不是滑动模式且有交点，不允许
        if (!slipping && numberOfIntersections !== 0) {
          return;
        }

        // 根据交点数量和目标决定是否处理点击
        if (numberOfIntersections === 0 && event.target === this.shapeContour!.node) {
          // 在形状上移动，留下新点
          click(event);
        } else if (numberOfIntersections === 1 && points.length > 2) {
          // 可能在轮廓外，可能在轮廓内
          // 这种情况需要至少一个中间点
          click(event);
        } else {
          return;
        }

        // 检查切片是否仍然启用
        // 因为click()可能会从内部完成切片
        // 例如当在轮廓外点击并启用shift时
        if (this.enabled) {
          points.push([x, y]);
          this.slicingLine!.plot(stringifyPoints(points.flat()));
        }
      }
    };

    /**
     * 处理画布鼠标移动事件
     * 更新切片线的最后一个点，支持滑动模式
     * @param event - 鼠标事件
     */
    const handleCanvasMousemove = (event: MouseEvent): void => {
      // 如果有点，处理鼠标移动
      if (points.length) {
        // 将鼠标坐标转换为SVG坐标系
        const [x, y] = translateToSVG(this.canvas.node as any as SVGSVGElement, [
          event.clientX,
          event.clientY,
        ]);
        // 获取前一个点
        const [prevX, prevY] = points[points.length - 2];
        // 更新最后一个点的位置
        points[points.length - 1] = [x, y];

        // 如果按住Shift键，启用滑动模式
        if (event.shiftKey) {
          // 计算距离
          const d = Math.sqrt((prevX - x) ** 2 + (prevY - y) ** 2);
          // 设置阈值，考虑缩放比例
          const threshold = 10 / this.geometry.scale;
          // 如果距离超过阈值，处理形状鼠标按下事件（滑动模式）
          if (d > threshold) {
            handleShapeMousedown(event, true);
          }
        } else {
          // 普通模式，只更新切片线
          this.slicingLine!.plot(stringifyPoints(points.flat()));
        }
      }
    };

    // 为形状轮廓添加鼠标按下事件监听器
    this.shapeContour.on("mousedown.slice", handleShapeMousedown);
    // 为画布添加鼠标按下事件监听器
    this.canvas.on("mousedown.slice", handleCanvasMousedown);
    // 为画布添加鼠标移动事件监听器
    this.canvas.on("mousemove.slice", handleCanvasMousemove);
  }

  /**
   * 释放切片处理器资源
   * 清理所有UI元素、事件监听器和状态，恢复画布到初始状态
   */
  private release(): void {
    // 禁用对象选择器
    this.objectSelector.disable();
    // 显示所有之前隐藏的对象
    this.hiddenClientIDs.forEach((clientIDs) => {
      this.showObject(clientIDs);
    });

    // 移除切片线
    if (this.slicingLine) {
      this.slicingLine.remove();
      this.slicingLine = null;
    }

    // 移除形状轮廓及其事件监听器
    if (this.shapeContour) {
      this.shapeContour.off("mousedown.slice");
      this.shapeContour.remove();
      this.shapeContour = null;
    }

    // 移除所有切片控制点
    this.slicingPoints.forEach((circle) => {
      circle.remove();
    });
    this.slicingPoints = [];

    // 移除画布事件监听器
    this.canvas.off("mousedown.slice");
    this.canvas.off("mousemove.slice");
    // 重置启用状态
    this.enabled = false;
    // 调用切片完成回调（无参数表示取消）
    this.onSliceDone();
    // 清除消息通知
    this.onMessage(null, "slice");
  }

  /**
   * 切片操作入口方法
   * 根据传入的切片数据初始化或取消切片操作
   * @param sliceData - 切片数据，包含启用状态、客户端ID和轮廓获取函数
   */
  public slice(sliceData: SliceData): void {
    /**
     * 使用形状轮廓初始化切片操作
     * @param state - 形状状态对象，包含形状类型和其他属性
     */
    const initializeWithContour = (state: any): void => {
      // 记录操作开始时间戳
      this.startTimestamp = Date.now();
      const { startTimestamp } = this;

      // 显示加载提示消息
      this.onMessage(
        [
          {
            type: "text",
            content: "Getting shape contour",
            icon: "loading",
          },
        ],
        "force"
      );

      // 获取形状轮廓
      if (sliceData.getContour) {
        sliceData
          .getContour(state)
          .then((contour: number[]) => {
            const { shapeType } = state;
            // 检查操作是否仍然有效（用户没有取消或重新初始化）
            if (this.startTimestamp === startTimestamp && this.enabled) {
              // 初始化切片操作
              this.initialize({
                enabled: true,
                contour,
                state,
                shapeType,
              });
            }
          })
          .catch((error: unknown) => {
            // 处理错误，释放资源并通知错误
            this.release();
            this.onError(error);
          });
      }
    };

    // 如果启用切片且当前未启用，且有轮廓获取函数
    if (sliceData.enabled && !this.enabled && sliceData.getContour) {
      // 设置启用状态
      this.enabled = true;
      // 如果指定了客户端ID
      if (sliceData.clientID) {
        // 查找对应的形状状态
        const state = this.getObjects().find(
          (_state) => _state.clientID === sliceData.clientID
        );
        // 验证形状类型是否支持切片（多边形或遮罩）
        if (
          state &&
          state.objectType === "shape" &&
          ["polygon", "mask"].includes(state.shapeType)
        ) {
          // 初始化切片操作
          initializeWithContour(state);
          return;
        }
      }

      // 显示选择形状的提示消息
      this.onMessage(
        [
          {
            type: "text",
            content: "Click a mask or polygon shape you would like to slice",
            icon: "info",
          },
        ],
        "slice"
      );

      // 启用对象选择器，让用户选择要切片的形状
      this.objectSelector.enable(
        ([state]) => {
          // 用户选择形状后，禁用选择器并初始化切片操作
          this.objectSelector.disable();
          initializeWithContour(state);
        },
        { maxCount: 1, shapeType: ["polygon", "mask"], objectType: ["shape"] }
      );
    } else if (this.enabled && !sliceData.enabled) {
      // 如果当前启用但请求禁用，释放资源
      this.release();
    }
  }

  /**
   * 取消切片操作
   * 如果当前处于切片模式，则释放资源并取消操作
   */
  public cancel(): void {
    if (this.enabled) {
      this.release();
    }
  }

  /**
   * 应用几何变换
   * 根据新的几何参数更新UI元素的缩放和位置
   * @param geometry - 几何参数，包含缩放比例等信息
   */
  public transform(geometry: Geometry): void {
    // 更新几何参数
    this.geometry = geometry;
    // 更新切片线宽度
    if (this.slicingLine) {
      this.slicingLine.attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / geometry.scale,
      });
    }

    // 更新形状轮廓线宽度
    if (this.shapeContour) {
      this.shapeContour.attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / geometry.scale,
      });
    }

    // 更新所有控制点的大小和线宽
    this.slicingPoints.forEach((point) => {
      point.radius(this.controlPointSize / geometry.scale);
      point.attr("stroke-width", consts.BASE_STROKE_WIDTH / this.geometry.scale);
    });
  }

  /**
   * 配置切片处理器参数
   * 更新控制点大小和边框样式等配置
   * @param config - 配置对象，包含控制点大小和边框颜色等设置
   */
  public configure(config: Configuration): void {
    // 更新控制点大小，使用配置值或默认值
    this.controlPointSize = config.controlPointsSize || consts.BASE_POINT_SIZE;
    // 更新边框颜色，使用配置值或默认值
    this.outlinedBorders = config.outlinedBorders || "black";
    // 更新切片线颜色
    if (this.slicingLine) this.slicingLine.attr("stroke", this.outlinedBorders);
    // 更新形状轮廓线颜色
    if (this.shapeContour) this.shapeContour.attr("stroke", this.outlinedBorders);
  }
}
