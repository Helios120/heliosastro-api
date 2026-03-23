const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const PDFDocument = require("pdfkit");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const ordersStore = new Map();

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variable manquante : ${name}`);
  return value;
}

function sanitizeText(value, maxLength = 1200) {
  if (!value) return "";
  return String(value).replace(/[<>]/g, "").trim().slice(0, maxLength);
}

async function getPayPalAccessToken() {
  const response = await axios({
    method: "post",
    url: `${env("PAYPAL_BASE_URL")}/v1/oauth2/token`,
    auth: {
      username: env("PAYPAL_CLIENT_ID"),
      password: env("PAYPAL_CLIENT_SECRET")
    },
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    data: "grant_type=client_credentials"
  });

  return response.data.access_token;
}

function buildAstroSummary(customerData) {
  const productMap = {
    "theme-natal": "Thème natal",
    "degres-360": "Interprétation 360 degrés",
    "transits": "Transits actuels"
  };

  const productLabel = productMap[customerData.productType] || "Rapport personnalisé";

  return {
    title: `Rapport HeliosAstro — ${productLabel}`,
    intro: `Ce rapport a été généré pour ${customerData.name}.`,
    profile: [
      `Nom : ${customerData.name}`,
      `Email : ${customerData.email}`,
      `Date de naissance : ${customerData.birthDate || "Non renseignée"}`,
      `Heure de naissance : ${customerData.birthTime || "Non renseignée"}`,
      `Lieu de naissance : ${customerData.birthPlace || "Non renseigné"}`
    ],
    interpretation: [
      "Cette version sert de socle propre et vendable pour ton futur moteur astrologique complet.",
      "Tu peux brancher ici les calculs de thème natal, maisons, aspects, positions planétaires et lectures symboliques.",
      "La logique business est déjà en place : commande, paiement, validation, génération PDF et livraison."
    ],
    notes: customerData.notes || "Aucune note client fournie."
  };
}

function generatePdfBuffer(customerData, orderId) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 50
      });

      const chunks = [];
      doc.on("data", chunk => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const content = buildAstroSummary(customerData);

      doc.fontSize(24).text("HELIOSASTRO", { align: "center" });
      doc.moveDown(0.3);
      doc.fontSize(18).text(content.title, { align: "center" });
      doc.moveDown(1);

      doc.fontSize(10).text(`Commande : ${orderId}`, { align: "right" });
      doc.moveDown(1);

      doc.fontSize(12).text(content.intro);
      doc.moveDown(1);

      doc.fontSize(14).text("Informations client", { underline: true });
      doc.moveDown(0.5);

      content.profile.forEach((line) => {
        doc.fontSize(12).text(`• ${line}`);
      });

      doc.moveDown(1);

      doc.fontSize(14).text("Structure du rapport", { underline: true });
      doc.moveDown(0.5);

      content.interpretation.forEach((line) => {
        doc.fontSize(12).text(`• ${line}`);
        doc.moveDown(0.4);
      });

      doc.moveDown(0.6);
      doc.fontSize(14).text("Question / note client", { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(12).text(content.notes);

      doc.moveDown(2);
      doc.fontSize(10).text(
        "Document généré automatiquement après validation du paiement PayPal.",
        { align: "center" }
      );

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "heliosastro-api"
  });
});

app.get("/api/config", (req, res) => {
  try {
    res.json({
      paypalClientId: env("PAYPAL_CLIENT_ID"),
      price: process.env.PRODUCT_PRICE || "49.00",
      currency: process.env.CURRENCY || "EUR",
      productName: process.env.PRODUCT_NAME || "Rapport astrologique HeliosAstro"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/create-order", async (req, res) => {
  try {
    const customerData = {
      name: sanitizeText(req.body.name, 80),
      email: sanitizeText(req.body.email, 120),
      birthDate: sanitizeText(req.body.birthDate, 40),
      birthTime: sanitizeText(req.body.birthTime, 20),
      birthPlace: sanitizeText(req.body.birthPlace, 120),
      productType: sanitizeText(req.body.productType, 50),
      notes: sanitizeText(req.body.notes, 1500)
    };

    if (!customerData.name || !customerData.email) {
      return res.status(400).json({ error: "Nom et email requis." });
    }

    const accessToken = await getPayPalAccessToken();

    const payload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          description: process.env.PRODUCT_NAME || "Rapport astrologique HeliosAstro",
          amount: {
            currency_code: process.env.CURRENCY || "EUR",
            value: process.env.PRODUCT_PRICE || "49.00"
          }
        }
      ],
      application_context: {
        brand_name: "HeliosAstro",
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING"
      }
    };

    const paypalResponse = await axios.post(
      `${env("PAYPAL_BASE_URL")}/v2/checkout/orders`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const orderId = paypalResponse.data.id;

    ordersStore.set(orderId, {
      status: "CREATED",
      customerData,
      createdAt: new Date().toISOString()
    });

    res.json({ id: orderId });
  } catch (error) {
    const message =
      error.response?.data?.message ||
      error.response?.data ||
      error.message ||
      "Erreur create-order";

    res.status(500).json({
      error: typeof message === "string" ? message : JSON.stringify(message)
    });
  }
});

app.post("/api/capture-order", async (req, res) => {
  try {
    const orderId = sanitizeText(req.body.orderID, 80);

    if (!orderId) {
      return res.status(400).json({ error: "orderID manquant." });
    }

    const orderState = ordersStore.get(orderId);

    if (!orderState) {
      return res.status(404).json({ error: "Commande introuvable côté serveur." });
    }

    const accessToken = await getPayPalAccessToken();

    const captureResponse = await axios.post(
      `${env("PAYPAL_BASE_URL")}/v2/checkout/orders/${orderId}/capture`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    orderState.status = "PAID";
    orderState.capture = captureResponse.data;
    orderState.paidAt = new Date().toISOString();
    ordersStore.set(orderId, orderState);

    res.json({
      success: true,
      orderId,
      downloadUrl: `/api/download-pdf/${orderId}`
    });
  } catch (error) {
    const message =
      error.response?.data?.message ||
      error.response?.data ||
      error.message ||
      "Erreur capture-order";

    res.status(500).json({
      error: typeof message === "string" ? message : JSON.stringify(message)
    });
  }
});

app.get("/api/download-pdf/:orderId", async (req, res) => {
  try {
    const orderId = sanitizeText(req.params.orderId, 80);
    const orderState = ordersStore.get(orderId);

    if (!orderState) {
      return res.status(404).send("Commande introuvable.");
    }

    if (orderState.status !== "PAID") {
      return res.status(403).send("Paiement non validé.");
    }

    const pdfBuffer = await generatePdfBuffer(orderState.customerData, orderId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="heliosastro-${orderId}.pdf"`
    );

    res.send(pdfBuffer);
  } catch (error) {
    res.status(500).send(`Erreur PDF : ${error.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`API lancée sur le port ${PORT}`);
});
