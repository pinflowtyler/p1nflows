const https = require("https");
const crypto = require("crypto");

// Amazon Product Advertising API v5 helper
function sign(key, msg) {
  return crypto.createHmac("sha256", key).update(msg).digest();
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate    = sign("AWS4" + key, dateStamp);
  const kRegion  = sign(kDate, regionName);
  const kService = sign(kRegion, serviceName);
  const kSigning = sign(kService, "aws4_request");
  return kSigning;
}

function toHex(buffer) {
  return buffer.toString("hex");
}

exports.handler = async function (event) {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  try {
    const { query, usedASINs = [] } = JSON.parse(event.body || "{}");
    if (!query) throw new Error("No query provided");

    const ACCESS_KEY  = process.env.AMAZON_ACCESS_KEY;
    const SECRET_KEY  = process.env.AMAZON_SECRET_KEY;
    const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG;

    if (!ACCESS_KEY || !SECRET_KEY || !PARTNER_TAG) {
      throw new Error("Amazon credentials not configured in Netlify environment variables");
    }

    // Build the request payload
    const payload = JSON.stringify({
      Keywords: query,
      Resources: [
        "Images.Primary.Large",
        "ItemInfo.Title",
        "ItemInfo.Features",
        "Offers.Listings.Price",
        "BrowseNodeInfo.BrowseNodes",
      ],
      SearchIndex: "All",
      ItemCount: 10,
      PartnerTag: PARTNER_TAG,
      PartnerType: "Associates",
      Marketplace: "www.amazon.com",
      SortBy: "Relevance",
    });

    // AWS Signature V4
    const service   = "ProductAdvertisingAPI";
    const region    = "us-east-1";
    const host      = "webservices.amazon.com";
    const endpoint  = "/paapi5/searchitems";
    const algorithm = "AWS4-HMAC-SHA256";

    const now         = new Date();
    const amzDate     = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
    const dateStamp   = amzDate.slice(0, 8);
    const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");

    const canonicalHeaders =
      `content-encoding:amz-1.0\n` +
      `content-type:application/json; charset=utf-8\n` +
      `host:${host}\n` +
      `x-amz-date:${amzDate}\n` +
      `x-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems\n`;

    const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";

    const canonicalRequest = [
      "POST",
      endpoint,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const signingKey = getSignatureKey(SECRET_KEY, dateStamp, region, service);
    const signature  = toHex(crypto.createHmac("sha256", signingKey).update(stringToSign).digest());

    const authHeader = `${algorithm} Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    // Make the request to Amazon
    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: host,
          path: endpoint,
          method: "POST",
          headers: {
            "content-encoding": "amz-1.0",
            "content-type": "application/json; charset=utf-8",
            "host": host,
            "x-amz-date": amzDate,
            "x-amz-target": "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
            "Authorization": authHeader,
            "content-length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error("Failed to parse Amazon response")); }
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    if (result.Errors) {
      throw new Error(result.Errors[0]?.Message || "Amazon API error");
    }

    const items = (result.SearchResult?.Items || []).filter(
      (item) => !usedASINs.includes(item.ASIN)
    );

    const products = items.map((item) => {
      const asin    = item.ASIN;
      const title   = item.ItemInfo?.Title?.DisplayValue || "Unknown Product";
      const image   = item.Images?.Primary?.Large?.URL || null;
      const price   = item.Offers?.Listings?.[0]?.Price?.DisplayAmount || null;
      const link    = `https://www.amazon.com/dp/${asin}?tag=${PARTNER_TAG}`;
      const preview = `https://www.amazon.com/dp/${asin}`;
      return { asin, title, image, price, link, preview };
    });

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ products }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
