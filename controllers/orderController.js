const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const Order = require("../models/order");
const User = require("../models/user");
const Product = require("../models/product");
const moment = require("moment");
const sortObject = require("../utils/format");
let config = require("config");
const querystring = require("qs");
const crypto = require("crypto");

const orderController = {
  getAllOrder: async (req, res) => {
    try {
      let { page, pageSize } = req.query;
      page = parseInt(page) || 1;
      pageSize = parseInt(pageSize) || 10;

      if (page <= 0) {
        return res.status(400).json({
          message: "Page number must be a positive integer",
          status: 400,
        });
      }

      if (pageSize <= 0) {
        return res.status(400).json({
          message: "Page size must be a positive integer",
          status: 400,
        });
      }

      const skip = (page - 1) * pageSize;

      const orders = await Order.find().skip(skip).limit(pageSize);
      const totalCount = await Order.countDocuments();

      if (skip >= totalCount) {
        return res.status(404).json({
          message: "Không tìm thấy đơn hàng",
          status: 404,
        });
      }

      return res.status(200).json({
        orders,
        currentPage: page,
        totalPages: Math.ceil(totalCount / pageSize),
        totalOrders: totalCount,
      });
    } catch (err) {
      return res.status(400).json(err);
    }
  },

  getDetailOrder: async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({
          message: "ID của đơn hàng không hợp lệ",
          status: 400,
        });
      }

      const orderInfo = await Order.findById(req.params.id);
      if (!orderInfo) {
        return res.status(404).json({
          message: "Không tìm thấy đơn hàng",
          status: 404,
        });
      }

      return res.status(200).json({ orderInfo });
    } catch (err) {
      return res.status(400).json(err);
    }
  },

  getOrderListByUserId: async (req, res) => {
    try {
      let { page, pageSize } = req.query;
      const userId = req.user.id;

      page = parseInt(page) || 1;
      pageSize = parseInt(pageSize) || 10;

      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({
          message: "ID của người dùng không hợp lệ",
          status: 400,
        });
      }

      if (page <= 0) {
        return res.status(400).json({
          message: "Page number must be a positive integer",
          status: 400,
        });
      }

      if (pageSize <= 0) {
        return res.status(400).json({
          message: "Page size must be a positive integer",
          status: 400,
        });
      }

      const skip = (page - 1) * pageSize;

      const totalOrders = await Order.countDocuments({ userId });
      const orders = await Order.find({ userId }).skip(skip).limit(pageSize);

      if (skip >= totalOrders) {
        return res.status(404).json({
          message: "Không tìm thấy đơn hàng",
          status: 404,
        });
      }

      return res.status(200).json({
        orders,
        currentPage: page,
        totalPages: Math.ceil(totalOrders / pageSize),
        totalOrders: totalOrders,
      });
    } catch (err) {
      return res.status(400).json(err);
    }
  },

  createOrder: async (req, res) => {
    try {
      const {
        orderProducts,
        userId,
        paymentMethod,
        itemsPrice,
        transferPrice,
        totalPrice,
        transferAddress,
      } = req.body;

      const errors = [];
      const { fullName, address, phone } = transferAddress;

      if (!fullName || !address || !phone) {
        errors.push("Mọi trường dữ liệu đều bắt buộc");
      }

      if (!orderProducts || orderProducts.length === 0) {
        errors.push("Không có sản phẩm nào được đặt hàng");
      }

      if (!paymentMethod || !itemsPrice || !transferPrice || !totalPrice) {
        errors.push("Mọi trường dữ liệu khi thanh toán đều bắt buộc");
      }

      const invalidProducts = orderProducts.filter(
        (product) => !product.amount
      );

      if (invalidProducts.length > 0) {
        errors.push("Mọi trường dữ liệu khi chọn sản phẩm đều bắt buộc");
      }

      const orderProductIds = orderProducts.map((product) => product.productId);
      const existingProducts = await Product.find({
        _id: { $in: orderProductIds },
      });

      if (existingProducts.length !== orderProductIds.length) {
        return res.status(404).json({
          message: "Không tìm thấy sản phẩm nào khi đặt hàng",
          status: 404,
        });
      }

      if (errors.length > 0) {
        return res.status(400).json({
          message: errors,
          status: 400,
        });
      }

      let user = null;
      if (userId) {
        user = await User.findById(userId);
        if (!user) {
          return res.status(404).json({
            message: "Không tìm thấy người dùng",
            status: 404,
          });
        }
        if (user.role.includes("STAFF") || user.role.includes("ADMIN")) {
          return res.status(403).json({
            message: "Admin và quản lý không có quyền đặt hàng",
            status: 403,
          });
        }
      }

      const detailOrderProducts = await Promise.all(
        orderProducts.map(async (product) => {
          const foundProduct = await Product.findById(product.productId);
          if (!foundProduct) {
            errors.push("Không tìm thấy sản phẩm");
          }
          return {
            productId: product.productId,
            name: foundProduct.name,
            image: foundProduct.image,
            amount: product.amount,
            price: foundProduct.price,
          };
        })
      );

      for (const product of detailOrderProducts) {
        const foundProduct = await Product.findById(product.productId);
        if (foundProduct.status.includes("AVAILABLE")) {
          if (foundProduct.quantity < product.amount) {
            return res.status(404).json({
              message: `Sản phẩm chỉ còn ${foundProduct.quantity} trong kho`,
              status: 404,
            });
          }
          foundProduct.quantity -= product.amount;
          await foundProduct.save({ validateModifiedOnly: true });
        }

        if (foundProduct.status.includes("EXPIRE")) {
          return res.status(404).json({
            message: "Sản phẩm đã hết hạn",
            status: 404,
          });
        }
      }

      const order = await Order.create({
        orderProducts: detailOrderProducts,
        transferAddress: {
          fullName,
          address,
          phone,
        },
        paymentMethod,
        itemsPrice,
        transferPrice,
        totalPrice,
        userId,
      });

      if (
        user &&
        user.role.includes("MEMBER") &&
        order.paymentMethod.includes("VNPAY")
      ) {
        const amount = order.totalPrice;

        process.env.TZ = "Asia/Ho_Chi_Minh";
        let date = new Date();
        let createDate = moment(date).format("YYYYMMDDHHmmss");

        let ipAddr =
          req.headers["x-forwarded-for"] ||
          req.connection.remoteAddress ||
          req.socket.remoteAddress ||
          req.connection.socket.remoteAddress;

        let tmnCode = config.get("vnp_TmnCode");
        let secretKey = config.get("vnp_HashSecret");
        let vnpUrl = config.get("vnp_Url");
        let returnUrl = config.get("vnp_ReturnUrl");
        let orderId = order._id;

        let locale = "vn";
        let currCode = "VND";
        let vnp_Params = {};
        vnp_Params["vnp_Version"] = "2.1.0";
        vnp_Params["vnp_Command"] = "pay";
        vnp_Params["vnp_TmnCode"] = tmnCode;
        vnp_Params["vnp_Locale"] = locale;
        vnp_Params["vnp_CurrCode"] = currCode;
        vnp_Params["vnp_TxnRef"] = orderId;
        vnp_Params["vnp_OrderInfo"] = "Thanh toan cho ma GD:" + orderId;
        vnp_Params["vnp_OrderType"] = "other";
        vnp_Params["vnp_Amount"] = amount * 100;
        vnp_Params["vnp_ReturnUrl"] = returnUrl;
        vnp_Params["vnp_IpAddr"] = ipAddr;
        vnp_Params["vnp_CreateDate"] = createDate;

        console.log("VNPay Params:", vnp_Params);

        vnp_Params = sortObject(vnp_Params);

        let signData = querystring.stringify(vnp_Params, { encode: false });
        let hmac = crypto.createHmac("sha512", secretKey);
        let signed = hmac.update(Buffer.from(signData, "utf-8")).digest("hex");
        vnp_Params["vnp_SecureHash"] = signed;
        vnpUrl += "?" + querystring.stringify(vnp_Params, { encode: false });

        return res.status(200).json({
          data: vnpUrl,
          message:
            "Tạo đơn hàng thành công. Vui lòng chờ chuyển trang thanh toán Vnpay",
          status: 200,
        });
      } else {
        return res.status(200).json({
          message: "Tạo đơn hàng thành công",
          status: 200,
        });
      }
    } catch (err) {
      console.error("Error creating order:", err);
      return res.status(400).json(err);
    }
  },

  returnVnpay: async (req, res) => {
    let vnp_Params = req.query;

    let secureHash = vnp_Params["vnp_SecureHash"];

    delete vnp_Params["vnp_SecureHash"];
    delete vnp_Params["vnp_SecureHashType"];

    vnp_Params = sortObject(vnp_Params);

    let tmnCode = config.get("vnp_TmnCode");
    let secretKey = config.get("vnp_HashSecret");

    let signData = querystring.stringify(vnp_Params, { encode: false });
    let hmac = crypto.createHmac("sha512", secretKey);
    let signed = hmac.update(Buffer.from(signData, "utf-8")).digest("hex");

    if (secureHash === signed) {
      const orderId = vnp_Params["vnp_TxnRef"];
      const vnp_Amount = parseFloat(vnp_Params["vnp_Amount"]);
      const vnpay_Params_update = {
        ...vnp_Params,
        vnp_Amount: vnp_Amount / 100,
      };
      const redirectUrl = `http://localhost:3000/payment?${querystring.stringify(
        vnpay_Params_update
      )}`;

      await Order.findOneAndUpdate(
        { _id: orderId },
        { isPaid: true },
        { new: true }
      );

      return res.redirect(redirectUrl);
    } else {
      const redirectUrl = `http://localhost:3000/payment?${querystring.stringify(
        vnpay_Params_update
      )}`;
      return res.redirect(redirectUrl);
    }
  },
};

module.exports = orderController;
