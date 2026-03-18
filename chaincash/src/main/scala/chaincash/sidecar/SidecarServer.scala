package chaincash.sidecar

import com.sun.net.httpserver.{HttpExchange, HttpServer}
import java.net.InetSocketAddress
import io.circe.parser._
import io.circe.syntax._
import io.circe.Json
import org.ergoplatform.{ErgoAddressEncoder, P2PKAddress}
import org.ergoplatform.appkit.NetworkType
import scorex.crypto.encode.Base16
import sigmastate.AvlTreeFlags
import sigmastate.Values.{AvlTreeConstant, GroupElementConstant}
import sigmastate.serialization.{GroupElementSerializer, ValueSerializer}
import special.sigma.AvlTree
import work.lithos.plasma.PlasmaParameters
import work.lithos.plasma.collections.PlasmaMap

import scala.io.Source

/**
 * JVM Sidecar for Agent Tab.
 *
 * Wraps existing BasisDeployer code as HTTP endpoints.
 * Handles Ergo-specific operations: reserve deployment, NFT minting,
 * wallet key extraction, scanning, status.
 *
 * TESTNET ONLY — hard-fails if configured for mainnet.
 */
object SidecarServer extends App {

  // --- Configuration ---
  val nodeUrl = sys.env.getOrElse("ERGO_NODE_URL", "http://localhost:9052")
  val networkTypeStr = sys.env.getOrElse("ERGO_NETWORK_TYPE", "testnet")
  val port = sys.env.getOrElse("SIDECAR_PORT", "8081").toInt

  // TESTNET GUARDRAIL — hard fail on mainnet
  if (networkTypeStr.toLowerCase != "testnet") {
    System.err.println(s"FATAL: ERGO_NETWORK_TYPE must be 'testnet', got '$networkTypeStr'")
    System.err.println("This sidecar is configured for testnet only. Refusing to start.")
    System.exit(1)
  }

  val networkType = NetworkType.TESTNET
  val networkPrefix = networkType.networkPrefix
  val ergoAddressEncoder = new ErgoAddressEncoder(networkPrefix)

  // Compile basis contract for testnet
  val basisContractScript = {
    val contract = Source.fromFile("contracts/offchain/basis.es", "utf-8").getLines.mkString("\n")
    contract
  }
  val basisErgoTree = org.ergoplatform.appkit.AppkitHelpers.compile(
    new java.util.HashMap[String, Object](), basisContractScript, networkPrefix
  )
  val basisAddress = ergoAddressEncoder.fromProposition(basisErgoTree).get

  // Plasma tree config (matches BasisDeployer)
  val plasmaParams = PlasmaParameters(32, None)
  val InsertUpdate = AvlTreeFlags(insertAllowed = true, updateAllowed = true, removeAllowed = false)
  def emptyPlasmaMap = new PlasmaMap[Array[Byte], Array[Byte]](InsertUpdate, plasmaParams)
  def emptyTreeErgoValue = emptyPlasmaMap.ergoValue
  def emptyTree: AvlTree = emptyTreeErgoValue.getValue

  println(s"=== Agent Tab Sidecar ===")
  println(s"Network: $networkTypeStr (TESTNET ONLY)")
  println(s"Node URL: $nodeUrl")
  println(s"Basis address (testnet): ${basisAddress.toString}")
  println(s"Starting on port $port...")

  // --- Helper: call Ergo node API ---
  def nodeGet(path: String, apiKey: String = ""): (Int, String) = {
    val req = scalaj.http.Http(s"$nodeUrl$path")
    val reqWithKey = if (apiKey.nonEmpty) req.header("api_key", apiKey) else req
    val resp = reqWithKey.asString
    (resp.code, resp.body)
  }

  def nodePost(path: String, body: String, apiKey: String = ""): (Int, String) = {
    val req = scalaj.http.Http(s"$nodeUrl$path")
      .postData(body)
      .header("Content-Type", "application/json")
    val reqWithKey = if (apiKey.nonEmpty) req.header("api_key", apiKey) else req
    val resp = reqWithKey.asString
    (resp.code, resp.body)
  }

  /**
   * Extract raw 33-byte compressed public key hex from an Ergo P2PK address.
   */
  def extractPubKeyFromAddress(addressStr: String): Option[String] = {
    try {
      val addr = ergoAddressEncoder.fromString(addressStr).get
      addr match {
        case p2pk: P2PKAddress =>
          val pubKeyBytes = GroupElementSerializer.toBytes(p2pk.pubkey.value)
          Some(Base16.encode(pubKeyBytes))
        case _ => None
      }
    } catch {
      case _: Exception => None
    }
  }

  // --- HTTP Server ---
  val server = HttpServer.create(new InetSocketAddress(port), 0)

  // ===== /health =====
  server.createContext("/health", (exchange: HttpExchange) => {
    handleGet(exchange) {
      Json.obj(
        "status" -> "ok".asJson,
        "network" -> "testnet".asJson,
        "nodeUrl" -> nodeUrl.asJson,
        "basisAddress" -> basisAddress.toString.asJson,
        "sidecarVersion" -> "0.2.0".asJson
      )
    }
  })

  // ===== /network/height =====
  server.createContext("/network/height", (exchange: HttpExchange) => {
    handleGet(exchange) {
      try {
        val (code, body) = nodeGet("/info")
        val info = parse(body).getOrElse(Json.Null)
        val height = info.hcursor.downField("fullHeight").as[Long].getOrElse(0L)
        Json.obj("height" -> height.asJson)
      } catch {
        case e: Exception =>
          Json.obj("error" -> s"Failed to reach node: ${e.getMessage}".asJson)
      }
    }
  })

  // ===== /wallet/pubkey =====
  // Extracts wallet address and raw 33-byte compressed public key.
  server.createContext("/wallet/pubkey", (exchange: HttpExchange) => {
    handleGet(exchange) {
      val query = parseQuery(exchange)
      val apiKey = query.getOrElse("nodeApiKey", "")
      if (apiKey.isEmpty) {
        Json.obj("error" -> "Missing nodeApiKey parameter".asJson)
      } else {
        try {
          val (code, body) = nodeGet("/wallet/status", apiKey)
          if (code != 200) {
            Json.obj("error" -> s"Wallet API error ($code): $body".asJson)
          } else {
            val status = parse(body).getOrElse(Json.Null)
            val changeAddr = status.hcursor.downField("changeAddress").as[String].getOrElse("")
            if (changeAddr.isEmpty) {
              Json.obj("error" -> "No change address found. Is the wallet unlocked?".asJson)
            } else {
              extractPubKeyFromAddress(changeAddr) match {
                case Some(pubKeyHex) =>
                  Json.obj(
                    "address" -> changeAddr.asJson,
                    "pubKeyHex" -> pubKeyHex.asJson,
                    "pubKeyLength" -> (pubKeyHex.length / 2).asJson
                  )
                case None =>
                  Json.obj("error" -> s"Could not extract public key from address $changeAddr".asJson)
              }
            }
          }
        } catch {
          case e: Exception =>
            Json.obj("error" -> s"Failed: ${e.getMessage}".asJson)
        }
      }
    }
  })

  // ===== /nft/mint =====
  // Mints an NFT (amount=1 token) using the wallet.
  // Handles box selection and inputsRaw to satisfy Ergo's minting rule
  // (tokenId must equal first input box ID).
  server.createContext("/nft/mint", (exchange: HttpExchange) => {
    handlePost(exchange) { body =>
      val cursor = body.hcursor
      val name = cursor.downField("name").as[String].getOrElse("NFT")
      val apiKey = cursor.downField("nodeApiKey").as[String].getOrElse("")

      if (apiKey.isEmpty) {
        Json.obj("error" -> "Missing nodeApiKey".asJson)
      } else {
        try {
          // Get wallet address
          val (_, statusBody) = nodeGet("/wallet/status", apiKey)
          val changeAddr = parse(statusBody).getOrElse(Json.Null)
            .hcursor.downField("changeAddress").as[String].getOrElse("")
          if (changeAddr.isEmpty) {
            Json.obj("error" -> "Wallet not available or locked".asJson)
          } else {
            // Get an unspent box to use as token ID source
            val (boxCode, boxBody) = nodeGet(
              "/wallet/boxes/unspent?minConfirmations=1&minInclusionHeight=0",
              apiKey
            )
            if (boxCode != 200) {
              Json.obj("error" -> s"Could not fetch unspent boxes ($boxCode): $boxBody".asJson)
            } else {
              val boxes = parse(boxBody).getOrElse(Json.Null).asArray.getOrElse(Vector.empty)
              if (boxes.isEmpty) {
                Json.obj("error" -> "No unspent boxes available. Do you have test ERG?".asJson)
              } else {
                // Use first box's ID as the token ID (Ergo minting rule)
                val firstBoxId = boxes.head.hcursor.downField("box").downField("boxId")
                  .as[String].getOrElse("")

                if (firstBoxId.isEmpty) {
                  Json.obj("error" -> "Could not read box ID from unspent boxes".asJson)
                } else {
                  // Build mint transaction
                  // Force this box as input so tokenId == first input box ID
                  val mintRequest = Json.obj(
                    "requests" -> Json.arr(Json.obj(
                      "address" -> changeAddr.asJson,
                      "value" -> 1000000L.asJson, // 0.001 ERG to hold the token
                      "assets" -> Json.arr(Json.obj(
                        "tokenId" -> firstBoxId.asJson,
                        "amount" -> 1L.asJson
                      ))
                    )),
                    "fee" -> 2000000L.asJson,
                    "inputsRaw" -> Json.arr()
                  )

                  // Send transaction via wallet
                  val (txCode, txBody) = nodePost(
                    "/wallet/transaction/send",
                    mintRequest.noSpaces,
                    apiKey
                  )

                  if (txCode != 200) {
                    Json.obj(
                      "error" -> s"Mint transaction failed ($txCode)".asJson,
                      "detail" -> txBody.asJson,
                      "attemptedBoxId" -> firstBoxId.asJson
                    )
                  } else {
                    // txBody should be the transaction ID string
                    val txId = parse(txBody).getOrElse(Json.fromString(txBody))
                      .asString.getOrElse(txBody.replaceAll("\"", ""))

                    Json.obj(
                      "tokenId" -> firstBoxId.asJson,
                      "txId" -> txId.asJson,
                      "name" -> name.asJson,
                      "amount" -> 1L.asJson,
                      "note" -> "Token ID = first input box ID per Ergo minting rules. Wait for confirmation (~2 min).".asJson
                    )
                  }
                }
              }
            }
          }
        } catch {
          case e: Exception =>
            Json.obj("error" -> s"Mint failed: ${e.getMessage}".asJson)
        }
      }
    }
  })

  // ===== /reserve/deploy =====
  // Generates deployment request JSON (output specs only, not a transaction).
  server.createContext("/reserve/deploy", (exchange: HttpExchange) => {
    handlePost(exchange) { body =>
      val cursor = body.hcursor
      val ownerPubKeyHex = cursor.downField("ownerPubKeyHex").as[String].getOrElse("")
      val trackerNftId = cursor.downField("trackerNftId").as[String].getOrElse("")
      val reserveTokenId = cursor.downField("reserveTokenId").as[String].getOrElse("")
      val initialCollateral = cursor.downField("initialCollateralNanoErg").as[Long].getOrElse(1000000000L)

      if (ownerPubKeyHex.isEmpty || trackerNftId.isEmpty || reserveTokenId.isEmpty) {
        Json.obj("error" -> "Missing required fields: ownerPubKeyHex, trackerNftId, reserveTokenId".asJson)
      } else {
        try {
          val publicKeyBytes = Base16.decode(ownerPubKeyHex).get
          val groupElement = GroupElementSerializer.fromBytes(publicKeyBytes)
          val ownerKey = GroupElementConstant(groupElement)

          val ownerKeyEncoded = Base16.encode(ValueSerializer.serialize(ownerKey))
          val emptyTreeEncoded = Base16.encode(ValueSerializer.serialize(AvlTreeConstant(emptyTree)))
          val trackerNftBytes = Base16.decode(trackerNftId).get
          val trackerNftEncoded = Base16.encode(ValueSerializer.serialize(trackerNftBytes))

          val deploymentRequest = Json.arr(Json.obj(
            "address" -> basisAddress.toString.asJson,
            "value" -> initialCollateral.asJson,
            "assets" -> Json.arr(Json.obj(
              "tokenId" -> reserveTokenId.asJson,
              "amount" -> 1L.asJson
            )),
            "registers" -> Json.obj(
              "R4" -> ownerKeyEncoded.asJson,
              "R5" -> emptyTreeEncoded.asJson,
              "R6" -> trackerNftEncoded.asJson
            )
          ))

          val scanRequest = Json.obj(
            "scanName" -> "Basis Reserve".asJson,
            "walletInteraction" -> "shared".asJson,
            "removeOffchain" -> true.asJson,
            "trackingRule" -> Json.obj(
              "predicate" -> "containsAsset".asJson,
              "assetId" -> reserveTokenId.asJson
            )
          )

          Json.obj(
            "deploymentRequestJson" -> deploymentRequest,
            "reserveAddress" -> basisAddress.toString.asJson,
            "scanRequestJson" -> scanRequest,
            "network" -> "testnet".asJson
          )
        } catch {
          case e: Exception =>
            Json.obj("error" -> s"Deployment request failed: ${e.getMessage}".asJson)
        }
      }
    }
  })

  // ===== /reserve/build-and-submit =====
  // Full flow: generate deployment specs → build tx via wallet → submit.
  // Requires local node with wallet API access.
  server.createContext("/reserve/build-and-submit", (exchange: HttpExchange) => {
    handlePost(exchange) { body =>
      val cursor = body.hcursor
      val ownerAddress = cursor.downField("ownerAddress").as[String].getOrElse("")
      val trackerNftId = cursor.downField("trackerNftId").as[String].getOrElse("")
      val reserveTokenId = cursor.downField("reserveTokenId").as[String].getOrElse("")
      val initialCollateral = cursor.downField("initialCollateralNanoErg").as[Long].getOrElse(1000000000L)
      val apiKey = cursor.downField("nodeApiKey").as[String].getOrElse("")

      if (ownerAddress.isEmpty || trackerNftId.isEmpty || reserveTokenId.isEmpty || apiKey.isEmpty) {
        Json.obj("error" -> "Missing required fields: ownerAddress, trackerNftId, reserveTokenId, nodeApiKey".asJson)
      } else {
        try {
          // Step 1: Extract public key from address
          val pubKeyHex = extractPubKeyFromAddress(ownerAddress).getOrElse(
            throw new Exception(s"Could not extract public key from address: $ownerAddress")
          )

          // Step 2: Build deployment request
          val publicKeyBytes = Base16.decode(pubKeyHex).get
          val groupElement = GroupElementSerializer.fromBytes(publicKeyBytes)
          val ownerKey = GroupElementConstant(groupElement)

          val ownerKeyEncoded = Base16.encode(ValueSerializer.serialize(ownerKey))
          val emptyTreeEncoded = Base16.encode(ValueSerializer.serialize(AvlTreeConstant(emptyTree)))
          val trackerNftBytes = Base16.decode(trackerNftId).get
          val trackerNftEncoded = Base16.encode(ValueSerializer.serialize(trackerNftBytes))

          val deploymentOutputSpec = Json.arr(Json.obj(
            "address" -> basisAddress.toString.asJson,
            "value" -> initialCollateral.asJson,
            "assets" -> Json.arr(Json.obj(
              "tokenId" -> reserveTokenId.asJson,
              "amount" -> 1L.asJson
            )),
            "registers" -> Json.obj(
              "R4" -> ownerKeyEncoded.asJson,
              "R5" -> emptyTreeEncoded.asJson,
              "R6" -> trackerNftEncoded.asJson
            )
          ))

          // Step 3: Build transaction via wallet API
          val generateRequest = Json.obj(
            "requests" -> deploymentOutputSpec,
            "fee" -> 2000000L.asJson,
            "inputsRaw" -> Json.arr()
          )

          val (genCode, genBody) = nodePost(
            "/wallet/transaction/generate",
            generateRequest.noSpaces,
            apiKey
          )

          if (genCode != 200) {
            Json.obj(
              "error" -> s"Transaction generation failed ($genCode)".asJson,
              "detail" -> genBody.asJson,
              "deploymentRequest" -> deploymentOutputSpec
            )
          } else {
            // Step 4: Submit signed transaction
            val (submitCode, submitBody) = nodePost(
              "/transactions",
              genBody, // genBody is the signed transaction JSON
              apiKey
            )

            if (submitCode != 200) {
              Json.obj(
                "error" -> s"Transaction submission failed ($submitCode)".asJson,
                "detail" -> submitBody.asJson
              )
            } else {
              val txId = parse(submitBody).getOrElse(Json.fromString(submitBody))
                .asString.getOrElse(submitBody.replaceAll("\"", ""))

              // Step 5: Register scan
              val scanRequest = Json.obj(
                "scanName" -> "Basis Reserve".asJson,
                "walletInteraction" -> "shared".asJson,
                "removeOffchain" -> true.asJson,
                "trackingRule" -> Json.obj(
                  "predicate" -> "containsAsset".asJson,
                  "assetId" -> reserveTokenId.asJson
                )
              )

              val (scanCode, scanBody) = nodePost(
                "/scan/register",
                scanRequest.noSpaces,
                apiKey
              )

              Json.obj(
                "txId" -> txId.asJson,
                "reserveAddress" -> basisAddress.toString.asJson,
                "reserveTokenId" -> reserveTokenId.asJson,
                "trackerNftId" -> trackerNftId.asJson,
                "ownerPubKeyHex" -> pubKeyHex.asJson,
                "initialCollateralNanoErg" -> initialCollateral.asJson,
                "scanRegistered" -> (scanCode == 200).asJson,
                "network" -> "testnet".asJson,
                "status" -> "submitted".asJson,
                "note" -> "Transaction submitted. Wait ~2 min for confirmation, then check /reserve/status".asJson
              )
            }
          }
        } catch {
          case e: Exception =>
            Json.obj("error" -> s"Build-and-submit failed: ${e.getMessage}".asJson)
        }
      }
    }
  })

  // ===== /reserve/scan =====
  server.createContext("/reserve/scan", (exchange: HttpExchange) => {
    handlePost(exchange) { body =>
      val reserveTokenId = body.hcursor.downField("reserveTokenId").as[String].getOrElse("")
      if (reserveTokenId.isEmpty) {
        Json.obj("error" -> "Missing reserveTokenId".asJson)
      } else {
        Json.obj(
          "scanRequestJson" -> Json.obj(
            "scanName" -> "Basis Reserve".asJson,
            "walletInteraction" -> "shared".asJson,
            "removeOffchain" -> true.asJson,
            "trackingRule" -> Json.obj(
              "predicate" -> "containsAsset".asJson,
              "assetId" -> reserveTokenId.asJson
            )
          )
        )
      }
    }
  })

  // ===== /reserve/status =====
  server.createContext("/reserve/status", (exchange: HttpExchange) => {
    handleGet(exchange) {
      val query = parseQuery(exchange)
      val reserveTokenId = query.getOrElse("reserveTokenId", "")
      if (reserveTokenId.isEmpty) {
        Json.obj("error" -> "Missing reserveTokenId parameter".asJson)
      } else {
        try {
          val (code, body) = nodeGet(s"/blockchain/box/byTokenId/$reserveTokenId?offset=0&limit=1")

          if (code != 200) {
            Json.obj(
              "found" -> false.asJson,
              "boxId" -> Json.Null,
              "valueNanoErg" -> Json.Null,
              "ownerPubKey" -> Json.Null,
              "trackerNftId" -> Json.Null,
              "avlTreeDigest" -> Json.Null,
              "creationHeight" -> Json.Null,
              "note" -> "Could not query node or token not found".asJson
            )
          } else {
            val parsed = parse(body).getOrElse(Json.Null)
            val items = parsed.hcursor.downField("items").as[List[Json]].getOrElse(List.empty)

            if (items.isEmpty) {
              Json.obj(
                "found" -> false.asJson,
                "boxId" -> Json.Null,
                "valueNanoErg" -> Json.Null,
                "ownerPubKey" -> Json.Null,
                "trackerNftId" -> Json.Null,
                "avlTreeDigest" -> Json.Null,
                "creationHeight" -> Json.Null
              )
            } else {
              val box = items.head
              val boxId = box.hcursor.downField("boxId").as[String].getOrElse("")
              val value = box.hcursor.downField("value").as[Long].getOrElse(0L)
              val creationHeight = box.hcursor.downField("creationHeight").as[Int].getOrElse(0)
              val r4 = box.hcursor.downField("additionalRegisters").downField("R4").downField("serializedValue").as[String].getOrElse("")
              val r5 = box.hcursor.downField("additionalRegisters").downField("R5").downField("serializedValue").as[String].getOrElse("")
              val r6 = box.hcursor.downField("additionalRegisters").downField("R6").downField("serializedValue").as[String].getOrElse("")

              Json.obj(
                "found" -> true.asJson,
                "boxId" -> boxId.asJson,
                "valueNanoErg" -> value.asJson,
                "ownerPubKey" -> r4.asJson,
                "trackerNftId" -> r6.asJson,
                "avlTreeDigest" -> r5.asJson,
                "creationHeight" -> creationHeight.asJson
              )
            }
          }
        } catch {
          case e: Exception =>
            Json.obj(
              "found" -> false.asJson,
              "error" -> s"Node query failed: ${e.getMessage}".asJson
            )
        }
      }
    }
  })

  server.setExecutor(null)
  server.start()
  println(s"Sidecar running on http://localhost:$port")
  println("Endpoints: /health, /network/height, /wallet/pubkey, /nft/mint, /reserve/deploy, /reserve/build-and-submit, /reserve/scan, /reserve/status")

  // --- Helper methods ---

  def parseQuery(exchange: HttpExchange): Map[String, String] = {
    Option(exchange.getRequestURI.getQuery).getOrElse("").split("&").flatMap { p =>
      val parts = p.split("=", 2)
      if (parts.length == 2) Some(parts(0) -> parts(1)) else None
    }.toMap
  }

  def handleGet(exchange: HttpExchange)(handler: => Json): Unit = {
    if (exchange.getRequestMethod != "GET") {
      sendResponse(exchange, 405, Json.obj("error" -> "Method not allowed".asJson))
      return
    }
    try {
      val result = handler
      val status = if (result.hcursor.downField("error").succeeded) 400 else 200
      sendResponse(exchange, status, result)
    } catch {
      case e: Exception =>
        sendResponse(exchange, 500, Json.obj("error" -> s"Internal error: ${e.getMessage}".asJson))
    }
  }

  def handlePost(exchange: HttpExchange)(handler: Json => Json): Unit = {
    if (exchange.getRequestMethod != "POST") {
      sendResponse(exchange, 405, Json.obj("error" -> "Method not allowed".asJson))
      return
    }
    try {
      val bodyStr = Source.fromInputStream(exchange.getRequestBody).mkString
      val body = parse(bodyStr).getOrElse(Json.Null)
      val result = handler(body)
      val status = if (result.hcursor.downField("error").succeeded) 400 else 200
      sendResponse(exchange, status, result)
    } catch {
      case e: Exception =>
        sendResponse(exchange, 500, Json.obj("error" -> s"Internal error: ${e.getMessage}".asJson))
    }
  }

  def sendResponse(exchange: HttpExchange, status: Int, body: Json): Unit = {
    val bytes = body.noSpaces.getBytes("UTF-8")
    exchange.getResponseHeaders.add("Content-Type", "application/json")
    exchange.getResponseHeaders.add("Access-Control-Allow-Origin", "*")
    exchange.sendResponseHeaders(status, bytes.length)
    exchange.getResponseBody.write(bytes)
    exchange.getResponseBody.close()
  }
}
