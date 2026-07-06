// Copyright (C) 2019-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import type * as SVG from "svg.js";
import "svg.select.js";

import consts from "../consts/consts";
import type { Configuration, Geometry, PolyEditData } from "../core/canvasModel";
import { pointsToNumberArray, translateFromSVG } from "../utils/shared";

import type { AutoborderHandler } from "./autoborderHandler";

/**
 * 编辑处理器接口
 * 定义了编辑形状的基本方法和属性
 */
export interface EditHandler {
  /**
   * 编辑形状
   * @param editData 编辑数据，包含编辑状态和点ID等信息
   */
  edit(editData: PolyEditData): void;

  /**
   * 变换几何属性
   * @param geometry 几何信息，包含缩放比例等
   */
  transform(geometry: Geometry): void;

  /**
   * 配置编辑处理器
   * @param configuration 配置对象，包含控制点大小、边框颜色等设置
   */
  configure(configuration: Configuration): void;

  /**
   * 取消编辑
   */
  cancel(): void;

  /**
   * 编辑器是否启用
   */
  enabled: boolean;

  /**
   * 形状类型
   */
  shapeType: string;
}

/**
 * 编辑处理器实现类，负责处理形状的编辑功能
 * 支持多边形、折线和点形状的编辑，包括控制点操作、自动边界处理和几何变换等功能
 */
export class EditHandlerImpl implements EditHandler {
  /** 编辑完成回调函数，接收状态和点数组参数 */
  private onEditDone: (state: any, points: number[]) => void;
  /** 自动边界处理器 */
  private autoborderHandler: AutoborderHandler;
  /** 几何信息，包含缩放比例等 */
  private geometry: Geometry | null;
  /** SVG画布容器 */
  private canvas: SVG.Container;
  /** 编辑数据，包含编辑状态和点ID等信息 */
  private editData: PolyEditData | null;
  /** 正在编辑的形状 */
  private editedShape: SVG.Shape | null;
  /** 编辑线条 */
  private editLine: SVG.PolyLine | null;
  /** 克隆的多边形数组 */
  private clones: SVG.Polygon[];
  /** 控制点大小 */
  private controlPointsSize: number;
  /** 是否启用自动边界 */
  private autobordersEnabled: boolean;
  /** 是否启用智能切割 */
  private intelligentCutEnabled: boolean;
  /** 边框颜色 */
  private outlinedBorders: string;
  /** 是否正在编辑 */
  private isEditing: boolean;

  /**
   * 设置拖尾点的事件处理
   * @param circle 需要设置事件处理的SVG圆形元素
   * 为拖尾点添加鼠标悬停、离开和点击事件处理
   */
  private setupTrailingPoint(circle: SVG.Circle): void {
    // 鼠标进入事件：增加点的描边宽度
    circle.on("mouseenter", (): void => {
      circle.attr({
        "stroke-width": consts.POINTS_SELECTED_STROKE_WIDTH / this.geometry!.scale,
      });
    });

    // 鼠标离开事件：恢复点的默认描边宽度
    circle.on("mouseleave", (): void => {
      circle.attr({
        "stroke-width": consts.POINTS_STROKE_WIDTH / this.geometry!.scale,
      });
    });

    // 鼠标按下事件：如果是左键点击，则取消编辑
    circle.on("mousedown", (e: MouseEvent): void => {
      // 检查是否为左键点击
      if (e.button !== 0) return;
      // 取消编辑
      this.edit({ enabled: false });
    });
  }

  /**
   * 开始编辑形状
   * 初始化编辑线，设置事件监听器，并启动自动边界处理（如果启用）
   * 支持多边形、折线和点形状的编辑
   */
  private startEdit(): void {
    // 获取起始坐标点
    const [clientX, clientY] = translateFromSVG(
      this.canvas.node as any as SVGSVGElement,
      this.editedShape!.attr("points").split(" ")[this.editData!.pointID!].split(",")
    );

    // 创建模拟鼠标事件用于初始化编辑线
    const dummyEvent = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    });

    // 添加通过滑动编辑形状的功能
    // 需要记住最后绘制的点来实现滑动绘制
    const lastDrawnPoint: {
      x: number | null;
      y: number | null;
    } = {
      x: null,
      y: null,
    };

    // 设置鼠标移动事件监听器，用于处理按住Shift键时的滑动编辑
    this.canvas.on("mousemove.edit", (e: MouseEvent): void => {
      // 检查是否按住Shift键且形状类型为多边形或折线
      if (
        e.shiftKey &&
        ["polygon", "polyline"].includes(this.editData!.state.shapeType)
      ) {
        // 如果是第一次绘制点或没有记录的点
        if (lastDrawnPoint.x === null || lastDrawnPoint.y === null) {
          (this.editLine as any).draw("point", e);
        } else {
          // 计算当前点与上一个点的距离
          const deltaThreshold = 15;
          const dxsqr = (e.clientX - lastDrawnPoint.x) ** 2;
          const dysqr = (e.clientY - lastDrawnPoint.y) ** 2;
          const delta = Math.sqrt(dxsqr + dysqr);
          // 只有当移动距离超过阈值时才添加新点
          if (delta > deltaThreshold) {
            (this.editLine as any).draw("point", e);
          }
        }
      }
    });

    // 创建编辑线（多边形）
    this.editLine = (this.canvas as any).polyline();
    // 如果形状类型是折线，设置绘制更新事件处理
    if (this.editData!.state.shapeType === "polyline") {
      (this.editLine as any).on("drawupdate", (e: CustomEvent): void => {
        // 获取最后绘制的点并设置拖尾点事件处理
        const circle = (e.target as any).instance.remember("_paintHandler").set.last();
        if (circle) this.setupTrailingPoint(circle);
      });
    }

    // 配置编辑线的样式、属性和事件监听器
    (this.editLine as any)
      .addClass("cvat_canvas_shape_drawing")
      .style({
        "pointer-events": "none", // 禁用鼠标事件
        "fill-opacity": 0, // 设置填充透明度为0
      })
      .attr({
        "data-origin-client-id": this.editData!.state.clientID, // 设置客户端ID
        stroke: this.editedShape!.attr("stroke"), // 使用与编辑形状相同的描边颜色
      })
      .on("drawstart drawpoint", (e: CustomEvent): void => {
        // 绘制开始或添加点时更新几何变换并记录最后绘制的点
        this.transform(this.geometry!);
        lastDrawnPoint.x = e.detail.event.clientX;
        lastDrawnPoint.y = e.detail.event.clientY;
      })
      .on("drawupdate", (): void => this.transform(this.geometry!)) // 绘制更新时更新几何变换
      .draw(dummyEvent, { snapToGrid: 0.1 }); // 开始绘制，设置网格吸附精度为0.1

    // 如果形状类型是点，设置描边宽度为0并撤销初始绘制
    if (this.editData!.state.shapeType === "points") {
      this.editLine!.attr("stroke-width", 0);
      (this.editLine as any).draw("undo");
    }

    // 设置编辑事件监听器
    this.setupEditEvents();
    // 如果启用了自动边界，启动自动边界处理
    if (this.autobordersEnabled) {
      this.autoborderHandler.autoborder(
        true,
        this.editLine!,
        this.editData!.state.clientID
      );
    }
  }

  /**
   * 设置编辑事件监听器
   * 为画布添加鼠标按下事件处理，支持添加点和撤销操作
   */
  private setupEditEvents(): void {
    // 添加鼠标按下事件监听器，处理编辑操作
    this.canvas.on("mousedown.edit", (e: MouseEvent): void => {
      // 左键按下且未按Alt键时，添加新点
      if (e.button === 0 && !e.altKey) {
        (this.editLine as any).draw("point", e);
      }
      // 右键按下且编辑线存在时，执行撤销操作
      else if (e.button === 2 && this.editLine) {
        // 对于点形状或多于2个点的形状，允许撤销操作
        if (
          this.editData!.state.shapeType === "points" ||
          this.editLine.attr("points").split(" ").length > 2
        ) {
          (this.editLine as any).draw("undo");
        }
      }
    });
  }

  /**
   * 选择多边形并完成编辑
   * @param shape - 要选择的多边形SVG元素
   * 处理多边形的点坐标，调整偏移量，然后调用编辑完成回调
   */
  private selectPolygon(shape: SVG.Polygon): void {
    // 获取几何偏移量
    const { offset } = this.geometry!;
    // 获取多边形点坐标并减去偏移量
    const points = pointsToNumberArray(shape.attr("points")).map(
      (coord: number): number => coord - offset
    );

    // 获取编辑状态数据
    const { state } = this.editData!;
    // 禁用编辑模式
    this.edit({
      enabled: false,
    });
    // 调用编辑完成回调，传递状态和点坐标
    this.onEditDone(state, points);
  }

  /**
   * 停止编辑并处理编辑结果
   * @param e - 鼠标事件对象
   * 根据形状类型处理编辑结果，支持多边形分割、折线编辑和点编辑
   */
  private stopEdit(e: MouseEvent): void {
    // 如果编辑线不存在，直接返回
    if (!this.editLine) {
      return;
    }

    // 获取停止点的索引和所有点数据
    const stopPointID = Array.prototype.indexOf.call(
      (e.target as HTMLElement).parentElement!.children,
      e.target
    );
    const oldPoints = this.editedShape!.attr("points").trim().split(" ");
    const linePoints = this.editLine.attr("points").trim().split(" ");

    // 如果编辑线只有一个点，取消编辑
    if (this.editLine.attr("points") === "0,0") {
      this.cancel();
      return;
    }

    // 计算起始点和停止点的排序索引
    const [start, stop] = [this.editData!.pointID, stopPointID].sort(
      (a, b): number => +a! - +b!
    );

    // 处理非多边形形状（折线和点）
    if (this.editData!.state.shapeType !== "polygon") {
      let points = null;
      // 获取几何偏移量
      const { offset } = this.geometry!;

      // 处理折线形状
      if (this.editData!.state.shapeType === "polyline") {
        // 如果起始点不是编辑点，反转线点顺序
        if (start !== this.editData!.pointID) {
          linePoints.reverse();
        }
        // 合并旧点和新点，形成完整的折线
        points = oldPoints
          .slice(0, start)
          .concat(linePoints)
          .concat(oldPoints.slice(stop! + 1));
      }
      // 处理点形状
      else {
        // 将旧点与新点合并（排除最后一个点）
        points = oldPoints.concat(linePoints.slice(0, -1));
      }

      // 转换点坐标并减去偏移量
      points = pointsToNumberArray(points.join(" ")).map(
        (coord: number): number => coord - offset
      );

      // 获取编辑状态数据
      const { state } = this.editData!;
      // 禁用编辑模式
      this.edit({
        enabled: false,
      });
      // 调用编辑完成回调，传递状态和点坐标
      this.onEditDone(state, points);

      return;
    }

    // 处理多边形形状的分割
    // 计算第一部分点的索引（保留起始点到停止点之外的部分）
    const cutIndexes1 = oldPoints.reduce(
      (acc: number[], _: string, i: number): number[] =>
        i >= stop! || i <= start! ? [...acc, i] : acc,
      []
    );
    // 计算第二部分点的索引（保留起始点到停止点之间的部分）
    const cutIndexes2 = oldPoints.reduce(
      (acc: number[], _: string, i: number): number[] =>
        i <= stop! && i >= start! ? [...acc, i] : acc,
      []
    );

    // 计算曲线长度的辅助函数
    const curveLength = (indexes: number[]): number => {
      // 根据索引获取点坐标
      const points = indexes
        .map((index: number): string => oldPoints[index])
        .map((point: string): string[] => point.split(","))
        .map((point: string[]): number[] => [+point[0], +point[1]]);
      let length = 0;
      // 计算相邻点之间的距离之和
      for (let i = 1; i < points.length; i++) {
        const dxsqr = (points[i][0] - points[i - 1][0]) ** 2;
        const dysqr = (points[i][1] - points[i - 1][1]) ** 2;
        length += Math.sqrt(dxsqr + dysqr);
      }

      return length;
    };

    // 判断分割标准的条件
    const pointsCriteria = cutIndexes1.length > cutIndexes2.length; // 点数标准
    const lengthCriteria = curveLength(cutIndexes1) > curveLength(cutIndexes2); // 长度标准

    // 如果起始点不是编辑点，反转线点顺序
    if (start !== this.editData!.pointID) {
      linePoints.reverse();
    }

    // 构建第一部分点（保留起始点之前和停止点之后的点，加上新绘制的线）
    const firstPart = oldPoints
      .slice(0, start)
      .concat(linePoints)
      .concat(oldPoints.slice(stop! + 1));
    // 构建第二部分点（起始点到停止点之间的点，加上反转的新绘制线）
    const secondPart = oldPoints.slice(start, stop).concat(linePoints.slice(1).reverse());

    // 如果任一部分点数少于3，取消编辑（无法形成有效多边形）
    if (firstPart.length < 3 || secondPart.length < 3) {
      this.cancel();
      return;
    }

    // 移除不再需要的事件监听器
    this.canvas.off("mousedown.edit");
    this.canvas.off("mousemove.edit");

    // 停止编辑线的绘制并移除
    (this.editLine as any).draw("stop");
    this.editLine.remove();
    this.editLine = null;

    // 根据分割标准和智能切割设置处理多边形分割结果
    if (pointsCriteria && lengthCriteria && this.intelligentCutEnabled) {
      // 智能切割模式：选择第一部分作为主要多边形
      this.clones.push(this.canvas.polygon(firstPart.join(" ")));
      this.selectPolygon(this.clones[0]);
    } else if (!pointsCriteria && !lengthCriteria && this.intelligentCutEnabled) {
      // 智能切割模式：选择第二部分作为主要多边形
      this.clones.push(this.canvas.polygon(secondPart.join(" ")));
      this.selectPolygon(this.clones[0]);
    } else {
      // 普通模式：创建两个多边形副本供用户选择
      for (const points of [firstPart, secondPart]) {
        this.clones.push(
          this.canvas
            .polygon(points.join(" "))
            .attr("fill", this.editedShape!.attr("fill")) // 使用原形状的填充色
            .attr("fill-opacity", "0.5") // 设置半透明填充
            .addClass("cvat_canvas_shape") // 添加形状样式类
        );
      }

      // 为每个多边形副本添加事件监听器
      for (const clone of this.clones) {
        // 点击事件：选择多边形
        clone.on("click", (): void => this.selectPolygon(clone));
        // 鼠标进入事件：添加分割样式类
        clone
          .on("mouseenter", (): void => {
            clone.addClass("cvat_canvas_shape_splitting");
          })
          // 鼠标离开事件：移除分割样式类
          .on("mouseleave", (): void => {
            clone.removeClass("cvat_canvas_shape_splitting");
          });
      }
    }
  }

  /**
   * 设置形状的控制点显示与交互
   * @param enabled - 是否启用控制点，true时启用并添加交互事件，false时禁用控制点
   */
  private setupPoints(enabled: boolean): void {
    // 绑定停止编辑方法
    const stopEdit = this.stopEdit.bind(this);
    // 获取几何信息的函数
    const getGeometry = (): Geometry => this.geometry!;
    // 获取形状的填充颜色，如果没有则使用继承的颜色
    const fill = this.editedShape!.attr("fill") || "inherit";

    if (enabled) {
      // 启用控制点选择功能
      (this.editedShape as any).selectize(true, {
        // 启用深度选择
        deepSelect: true,
        // 根据几何缩放计算控制点大小
        pointSize: (2 * this.controlPointsSize) / getGeometry().scale,
        // 禁用旋转点
        rotationPoint: false,
        // 自定义控制点类型
        pointType(cx: number, cy: number): SVG.Circle {
          // 创建圆形控制点
          const circle: SVG.Circle = this.nested
            .circle(this.options.pointSize)
            .stroke("black")
            .fill(fill)
            .center(cx, cy)
            .attr({
              "stroke-width": consts.POINTS_STROKE_WIDTH / getGeometry().scale,
            });

          // 鼠标进入控制点事件
          circle.node.addEventListener("mouseenter", (): void => {
            // 增加描边宽度以突出显示
            circle.attr({
              "stroke-width": consts.POINTS_SELECTED_STROKE_WIDTH / getGeometry().scale,
            });

            // 添加点击事件监听器
            circle.node.addEventListener("click", stopEdit);
            // 添加选中样式类
            circle.addClass("cvat_canvas_selected_point");
          });

          // 鼠标离开控制点事件
          circle.node.addEventListener("mouseleave", (): void => {
            // 恢复原始描边宽度
            circle.attr({
              "stroke-width": consts.POINTS_STROKE_WIDTH / getGeometry().scale,
            });

            // 移除点击事件监听器
            circle.node.removeEventListener("click", stopEdit);
            // 移除选中样式类
            circle.removeClass("cvat_canvas_selected_point");
          });

          return circle;
        },
      });
    } else {
      // 禁用控制点选择功能
      (this.editedShape as any).selectize(false, {
        deepSelect: true,
      });
    }
  }

  /**
   * 释放编辑资源并重置编辑状态
   * 移除事件监听器、停止自动边界处理、清除编辑形状和编辑线
   */
  private release(): void {
    // 移除鼠标按下事件监听器
    this.canvas.off("mousedown.edit");
    // 移除鼠标移动事件监听器
    this.canvas.off("mousemove.edit");
    // 停止自动边界处理
    this.autoborderHandler.autoborder(false);
    // 重置编辑状态
    this.isEditing = false;

    // 如果存在编辑形状，进行清理
    if (this.editedShape) {
      // 禁用控制点
      this.setupPoints(false);
      // 移除编辑形状
      this.editedShape.remove();
      // 清空编辑形状引用
      this.editedShape = null;
    }

    // 如果存在编辑线，进行清理
    if (this.editLine) {
      // 停止编辑线的绘制
      (this.editLine as any).draw("stop");
      // 移除编辑线
      this.editLine.remove();
      // 清空编辑线引用
      this.editLine = null;
    }

    // 如果存在克隆形状，进行清理
    if (this.clones.length) {
      // 遍历并移除所有克隆形状
      for (const clone of this.clones) {
        clone.remove();
      }
      // 清空克隆数组
      this.clones = [];
    }
  }

  /**
   * 初始化编辑状态
   * 克隆原始形状、设置控制点、启动编辑流程并标记为编辑中
   */
  private initEditing(): void {
    // 克隆原始形状并设置描边颜色为轮廓边框颜色
    this.editedShape = this.canvas
      .select(`#cvat_canvas_shape_${this.editData!.state.clientID}`)
      .first()
      .clone()
      .attr("stroke", this.outlinedBorders);
    // 启用控制点显示和交互
    this.setupPoints(true);
    // 开始编辑流程
    this.startEdit();
    // 标记为编辑中状态
    this.isEditing = true;
    // 为形状绘制控制点并开始编辑，直到另一个点被点击
    // 对于多边形，点击两个部分中的一个来移除该部分

    // 否则我们可以开始绘制折线
    // 在获得形状和点后，我们等待形状上的第二个点被按下
  }

  /**
   * 关闭编辑状态并处理编辑结果
   * 对于折线形状，合并编辑点和原始点并调用编辑完成回调
   * 最后释放所有编辑资源
   */
  private closeEditing(): void {
    // 如果正在编辑且形状类型为折线
    if (this.isEditing && this.editData!.state.shapeType === "polyline") {
      // 获取几何偏移量
      const { offset } = this.geometry!;
      // 获取编辑点之前的原始点部分
      const head = this.editedShape!.attr("points")
        .split(" ")
        .slice(0, this.editData!.pointID)
        .join(" ");
      // 合并原始点和编辑线的点（排除最后一个点）
      const stringifiedPoints = `${head} ${this.editLine!.node.getAttribute("points")!.slice(0, -2)}`;
      // 将点字符串转换为数字数组并减去偏移量
      const points = pointsToNumberArray(stringifiedPoints)
        .slice(0, -2)
        .map((coord: number): number => coord - offset);
      // 检查点数是否足够（至少需要2个点，即4个坐标值）
      if (points.length >= 2 * 2) {
        // minimumPoints * 2
        // 获取编辑状态
        const { state } = this.editData!;
        // 调用编辑完成回调，传递状态和点坐标
        this.onEditDone(state, points);
      }
    }
    // 释放所有编辑资源
    this.release();
  }

  /**
   * 创建EditHandlerImpl实例
   * @param onEditDone - 编辑完成时的回调函数，接收状态和点坐标参数
   * @param canvas - SVG画布容器，用于绘制形状和编辑线
   * @param autoborderHandler - 自动边界处理器，用于处理形状的自动边界
   */
  public constructor(
    onEditDone: EditHandlerImpl["onEditDone"],
    canvas: SVG.Container,
    autoborderHandler: AutoborderHandler
  ) {
    // 保存自动边界处理器引用
    this.autoborderHandler = autoborderHandler;
    // 初始化自动边界功能为禁用状态
    this.autobordersEnabled = false;
    // 初始化智能切割功能为禁用状态
    this.intelligentCutEnabled = false;
    // 设置控制点大小为默认值
    this.controlPointsSize = consts.BASE_POINT_SIZE;
    // 设置轮廓边框颜色为黑色
    this.outlinedBorders = "black";
    // 保存编辑完成回调函数
    this.onEditDone = onEditDone;
    // 保存SVG画布引用
    this.canvas = canvas;
    // 初始化编辑数据为null
    this.editData = null;
    // 初始化编辑形状为null
    this.editedShape = null;
    // 初始化编辑线为null
    this.editLine = null;
    // 初始化几何信息为null
    this.geometry = null;
    // 初始化克隆数组为空数组
    this.clones = [];
    // 初始化编辑状态为false
    this.isEditing = false;
  }

  /**
   * 启动或停止编辑模式
   * @param editData - 编辑数据对象，包含启用状态和形状状态信息
   */
  public edit(editData: any): void {
    // 如果启用编辑模式
    if (editData.enabled) {
      // 检查形状类型是否为支持编辑的类型（多边形、折线或点）
      if (["polygon", "polyline", "points"].includes(editData.state.shapeType)) {
        // 保存编辑数据
        this.editData = editData;
        // 初始化编辑状态
        this.initEditing();
      } else {
        // 不支持的形状类型，取消编辑
        this.cancel();
      }
    } else {
      // 禁用编辑模式，关闭当前编辑
      this.closeEditing();
      // 保存编辑数据
      this.editData = editData;
    }
  }

  /**
   * 取消编辑操作
   * 释放所有编辑资源并调用编辑完成回调，传递null值表示取消
   */
  public cancel(): void {
    // 释放所有编辑资源
    this.release();
    // 调用编辑完成回调，传递null值表示取消编辑
    this.onEditDone(null, []);
  }

  /**
   * 获取当前编辑状态
   * @returns 返回true表示正在编辑，false表示未在编辑
   */
  get enabled(): boolean {
    return this.isEditing;
  }

  /**
   * 获取当前编辑的形状类型
   * @returns 返回形状类型字符串，如'polygon'、'polyline'或'points'
   */
  get shapeType(): string {
    return this.editData!.state.shapeType;
  }

  /**
   * 配置编辑器的各种设置
   * @param configuration - 配置对象，包含自动边界、轮廓边框颜色、控制点大小和智能切割等设置
   */
  public configure(configuration: Configuration): void {
    // 设置自动边界功能是否启用
    this.autobordersEnabled = configuration.autoborders!;
    // 设置轮廓边框颜色，如果没有指定则使用黑色
    this.outlinedBorders = configuration.outlinedBorders || "black";

    // 如果存在编辑形状，更新其描边颜色
    if (this.editedShape) {
      this.editedShape.attr("stroke", this.outlinedBorders);
    }

    // 如果存在编辑线，更新其描边颜色和自动边界设置
    if (this.editLine) {
      this.editLine.attr("stroke", this.outlinedBorders);
      // 根据自动边界设置启用或禁用自动边界功能
      if (this.autobordersEnabled) {
        this.autoborderHandler.autoborder(
          true,
          this.editLine,
          this.editData!.state.clientID
        );
      } else {
        this.autoborderHandler.autoborder(false);
      }
    }
    // 设置控制点大小，如果没有指定则使用默认大小
    this.controlPointsSize = configuration.controlPointsSize || consts.BASE_POINT_SIZE;
    // 设置智能切割功能是否启用
    this.intelligentCutEnabled = configuration.intelligentPolygonCrop!;
  }

  /**
   * 应用几何变换到编辑中的形状
   * @param geometry - 包含缩放比例的几何变换对象
   */
  public transform(geometry: Geometry): void {
    // 保存几何信息
    this.geometry = geometry;

    // 如果存在编辑形状，根据缩放比例调整其描边宽度
    if (this.editedShape) {
      this.editedShape.attr({
        "stroke-width": consts.BASE_STROKE_WIDTH / geometry.scale,
      });
    }

    // 如果存在编辑线，根据缩放比例调整其描边宽度和控制点
    if (this.editLine) {
      // 对于非点形状，调整编辑线的描边宽度
      if (this.editData!.state.shapeType !== "points") {
        this.editLine.attr({
          "stroke-width": consts.BASE_STROKE_WIDTH / geometry.scale,
        });
      }

      // 获取绘制处理器并调整所有控制点的样式
      const paintHandler = this.editLine.remember("_paintHandler");
      for (const point of paintHandler.set.members) {
        // 调整控制点的描边宽度
        point.attr("stroke-width", `${consts.POINTS_STROKE_WIDTH / geometry.scale}`);
        // 调整控制点的半径大小
        point.attr("r", `${this.controlPointsSize / geometry.scale}`);
      }
    }
  }
}
