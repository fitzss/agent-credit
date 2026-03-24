package chaincash.sidecar

import com.sun.net.httpserver.{HttpExchange, HttpServer}
import java.net.InetSocketAddress
import io.circe.parser._
import io.circe.syntax._
import io.circe.Json
import org.ergoplatform.{ErgoAddressEncoder, P2PKAddress}
import org.ergoplatform.appkit.NetworkType
import com.google.common.primitives.Longs
import scorex.crypto.encode.Base16
import scorex.crypto.hash.Blake2b256
import sigmastate.AvlTreeFlags
import sigmastate.Values.{AvlTreeConstant, GroupElementConstant}
import sigmastate.basics.CryptoConstants
import sigmastate.serialization.{GroupElementSerializer, ValueSerializer}
import sigmastate.eval._
import special.sigma.AvlTree
import work.lithos.plasma.PlasmaParameters
import work.lithos.plasma.collections.PlasmaMap
import chaincash.offchain.SigUtils

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

  // --- Helper: parse and sort tracker entries by key for deterministic tree construction ---
  case class TrackerTreeEntry(ownerHex: String, receiverHex: String, totalDebt: Long, key: Array[Byte])

  def parseAndSortTrackerEntries(entries: Vector[Json]): Vector[TrackerTreeEntry] = {
    entries.map { entry =>
      val ownerHex = entry.hcursor.downField("ownerPubKeyHex").as[String].getOrElse("")
      val receiverHex = entry.hcursor.downField("receiverPubKeyHex").as[String].getOrElse("")
      val totalDebt = entry.hcursor.downField("totalDebtNanoErg").as[Long].getOrElse(0L)
      val ownerBytes = Base16.decode(ownerHex).get
      val receiverBytes = Base16.decode(receiverHex).get
      val key = Blake2b256(ownerBytes ++ receiverBytes)
      TrackerTreeEntry(ownerHex, receiverHex, totalDebt, key)
    }.sortBy(e => Base16.encode(e.key)) // deterministic order by key hash
  }

  def buildTrackerPlasmaMap(entries: Vector[TrackerTreeEntry]): PlasmaMap[Array[Byte], Array[Byte]] = {
    val basisPlasmaParams = PlasmaParameters(32, None)
    val plasmaMap = new PlasmaMap[Array[Byte], Array[Byte]](AvlTreeFlags.InsertOnly, basisPlasmaParams)
    for (e <- entries) {
      plasmaMap.insert((e.key, Longs.toByteArray(e.totalDebt)))
    }
    plasmaMap
  }

  // --- Helper: call Ergo node API ---
  // Increased timeouts to handle large wallet (500+ mining reward boxes)
  val nodeTimeout = 60000 // 60 seconds

  def nodeGet(path: String, apiKey: String = ""): (Int, String) = {
    val req = scalaj.http.Http(s"$nodeUrl$path").timeout(nodeTimeout, nodeTimeout)
    val reqWithKey = if (apiKey.nonEmpty) req.header("api_key", apiKey) else req
    val resp = reqWithKey.asString
    (resp.code, resp.body)
  }

  def nodePost(path: String, body: String, apiKey: String = ""): (Int, String) = {
    val req = scalaj.http.Http(s"$nodeUrl$path").timeout(nodeTimeout, nodeTimeout)
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
                  // Fetch raw bytes of the first box so we can force it as first input
                  val (rawCode, rawBody) = nodeGet(s"/utxo/byIdBinary/$firstBoxId")
                  val rawBytes = if (rawCode == 200) {
                    parse(rawBody).getOrElse(Json.Null)
                      .hcursor.downField("bytes").as[String].getOrElse("")
                  } else ""
                  val inputsRaw = if (rawBytes.nonEmpty) Json.arr(Json.fromString(rawBytes)) else Json.arr()

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
                    "inputsRaw" -> inputsRaw
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
              // Node API returns registers as flat hex strings or as {serializedValue: "..."} objects
              val regs = box.hcursor.downField("additionalRegisters")
              def readReg(name: String): String = {
                val field = regs.downField(name)
                field.downField("serializedValue").as[String].getOrElse(
                  field.as[String].getOrElse("")
                )
              }
              val r4raw = readReg("R4")
              val r5raw = readReg("R5")
              val r6raw = readReg("R6")

              // Decode register type prefixes to extract semantic values:
              // R4 (GroupElement): strip 0x07 type tag -> bare 33-byte compressed pubkey
              val ownerPubKey = if (r4raw.startsWith("07") && r4raw.length >= 68) r4raw.drop(2) else r4raw
              // R6 (Coll[Byte]): strip 0x0e type tag + 0x20 VLQ length -> bare 32-byte token ID
              val trackerNftId = if (r6raw.startsWith("0e20") && r6raw.length >= 68) r6raw.drop(4) else r6raw
              // R5 (AvlTree): strip 0x64 type tag -> AvlTreeData (digest + flags + keyLength + valueLengthOpt)
              val avlTreeDigest = if (r5raw.startsWith("64") && r5raw.length >= 4) r5raw.drop(2) else r5raw

              Json.obj(
                "found" -> true.asJson,
                "boxId" -> boxId.asJson,
                "valueNanoErg" -> value.asJson,
                "ownerPubKey" -> ownerPubKey.asJson,
                "trackerNftId" -> trackerNftId.asJson,
                "avlTreeDigest" -> avlTreeDigest.asJson,
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

  // ===== /tracker/deploy =====
  // Deploys a tracker box on-chain with a single debt entry in the AVL tree.
  // Generates a Schnorr keypair for the tracker, builds the tree, and submits.
  server.createContext("/tracker/deploy", (exchange: HttpExchange) => {
    handlePost(exchange) { body =>
      val cursor = body.hcursor
      val ownerPubKeyHex = cursor.downField("ownerPubKeyHex").as[String].getOrElse("")
      val receiverPubKeyHex = cursor.downField("receiverPubKeyHex").as[String].getOrElse("")
      val totalDebt = cursor.downField("totalDebtNanoErg").as[Long].getOrElse(0L)
      val trackerNftId = cursor.downField("trackerNftId").as[String].getOrElse("")
      val trackerNftBoxId = cursor.downField("trackerNftBoxId").as[String].getOrElse("")
      val apiKey = cursor.downField("nodeApiKey").as[String].getOrElse("")

      if (ownerPubKeyHex.isEmpty || receiverPubKeyHex.isEmpty || totalDebt <= 0 || trackerNftId.isEmpty || apiKey.isEmpty) {
        Json.obj("error" -> "Missing required fields: ownerPubKeyHex, receiverPubKeyHex, totalDebtNanoErg, trackerNftId, nodeApiKey".asJson)
      } else {
        try {
          // Step 1: Generate tracker Schnorr keypair
          val trackerSecret = SigUtils.randBigInt
          val g = CryptoConstants.dlogGroup.generator
          val trackerPk = g.exp(trackerSecret.bigInteger)
          val trackerPkBytes = GroupElementSerializer.toBytes(trackerPk)
          val trackerPkHex = Base16.encode(trackerPkBytes)

          // Step 2: Build AVL tree key: blake2b256(ownerPk || receiverPk)
          val ownerPkBytes = Base16.decode(ownerPubKeyHex).get
          val receiverPkBytes = Base16.decode(receiverPubKeyHex).get
          val key = Blake2b256(ownerPkBytes ++ receiverPkBytes)

          // Step 3: Build tracker AVL tree with single entry
          // Use InsertOnly + key size 32, matching BasisSpec
          val basisPlasmaParams = PlasmaParameters(32, None)
          val trackerPlasmaMap = new PlasmaMap[Array[Byte], Array[Byte]](
            AvlTreeFlags.InsertOnly, basisPlasmaParams
          )
          val insertRes = trackerPlasmaMap.insert((key, Longs.toByteArray(totalDebt)))
          val trackerTreeErgoValue = trackerPlasmaMap.ergoValue

          // Generate lookup proof for the entry we just inserted
          val lookupResult = trackerPlasmaMap.lookUp(key)
          val lookupProofBytes = lookupResult.proof.bytes
          val lookupProofHex = Base16.encode(lookupProofBytes)

          // Tree digest for verification
          val treeDigestHex = Base16.encode(trackerTreeErgoValue.getValue.digest.toArray)

          // Step 4: Encode registers for tracker box
          // R4 = tracker public key (GroupElement)
          val trackerPkConstant = GroupElementConstant(trackerPk)
          val r4Encoded = Base16.encode(ValueSerializer.serialize(trackerPkConstant))
          // R5 = AVL tree with debt entry
          val r5Encoded = Base16.encode(ValueSerializer.serialize(AvlTreeConstant(trackerTreeErgoValue.getValue)))

          // Step 5: Get wallet address for change
          val (_, statusBody) = nodeGet("/wallet/status", apiKey)
          val changeAddr = parse(statusBody).getOrElse(Json.Null)
            .hcursor.downField("changeAddress").as[String].getOrElse("")
          if (changeAddr.isEmpty) {
            throw new Exception("Wallet not available or locked")
          }

          // Step 6: Build transaction
          // Tracker box: holds tracker NFT, R4=trackerPk, R5=tree
          // Contract doesn't matter — tracker box is only used as data input (never spent in redemption)
          // Use wallet's own P2PK address so the wallet can manage it
          val generateRequest = Json.obj(
            "requests" -> Json.arr(Json.obj(
              "address" -> changeAddr.asJson,
              "value" -> 1000000L.asJson, // 0.001 ERG min value
              "assets" -> Json.arr(Json.obj(
                "tokenId" -> trackerNftId.asJson,
                "amount" -> 1L.asJson
              )),
              "registers" -> Json.obj(
                "R4" -> r4Encoded.asJson,
                "R5" -> r5Encoded.asJson
              )
            )),
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
              "generateRequest" -> generateRequest
            )
          } else {
            // Step 7: Submit signed transaction
            val (submitCode, submitBody) = nodePost(
              "/transactions",
              genBody,
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

              // Parse the signed tx to get the tracker box ID (first output)
              val signedTx = parse(genBody).getOrElse(Json.Null)
              val trackerBoxId = signedTx.hcursor
                .downField("outputs").downArray
                .downField("boxId").as[String].getOrElse("")

              // Write tracker secret to local file outside git tree
              // This file is needed for /reserve/redeem signing
              val secretDir = new java.io.File(System.getProperty("user.home"), ".chaincash-secrets")
              secretDir.mkdirs()
              val secretFile = new java.io.File(secretDir, s"tracker-${trackerNftId.take(8)}.json")
              val secretJson = Json.obj(
                "trackerNftId" -> trackerNftId.asJson,
                "trackerSecretHex" -> Base16.encode(trackerSecret.toByteArray).asJson,
                "trackerPubKeyHex" -> trackerPkHex.asJson,
                "trackerBoxId" -> trackerBoxId.asJson
              )
              val writer = new java.io.FileWriter(secretFile)
              writer.write(secretJson.spaces2)
              writer.close()

              Json.obj(
                "txId" -> txId.asJson,
                "trackerBoxId" -> trackerBoxId.asJson,
                "trackerPubKeyHex" -> trackerPkHex.asJson,
                "treeDigestHex" -> treeDigestHex.asJson,
                "lookupProofHex" -> lookupProofHex.asJson,
                "debtKeyHex" -> Base16.encode(key).asJson,
                "totalDebtNanoErg" -> totalDebt.asJson,
                "trackerNftId" -> trackerNftId.asJson,
                "status" -> "submitted".asJson,
                "secretFile" -> secretFile.getAbsolutePath.asJson,
                "note" -> "Tracker secret written to local file (outside git tree). Needed for /reserve/redeem.".asJson
              )
            }
          }
        } catch {
          case e: Exception =>
            Json.obj("error" -> s"Tracker deploy failed: ${e.getMessage}".asJson)
        }
      }
    }
  })

  // ===== /tracker/update =====
  // Creates a new tracker box with multiple (debtor, creditor) entries in the AVL tree.
  // Spends the old tracker box (to move the NFT), builds a multi-entry tree.
  server.createContext("/tracker/update", (exchange: HttpExchange) => {
    handlePost(exchange) { body =>
      val cursor = body.hcursor
      val trackerNftId = cursor.downField("trackerNftId").as[String].getOrElse("")
      val entries = cursor.downField("entries").as[Vector[Json]].getOrElse(Vector.empty)
      val apiKey = cursor.downField("nodeApiKey").as[String].getOrElse("")

      if (trackerNftId.isEmpty || entries.isEmpty || apiKey.isEmpty) {
        Json.obj("error" -> "Missing required fields: trackerNftId, entries[], nodeApiKey".asJson)
      } else {
        try {
          // Step 1: Generate tracker Schnorr keypair
          val trackerSecret = SigUtils.randBigInt
          val g = CryptoConstants.dlogGroup.generator
          val trackerPk = g.exp(trackerSecret.bigInteger)
          val trackerPkHex = Base16.encode(GroupElementSerializer.toBytes(trackerPk))

          // Step 2: Build multi-entry AVL tree (sorted by key for deterministic structure)
          val sortedEntries = parseAndSortTrackerEntries(entries)
          val trackerPlasmaMap = buildTrackerPlasmaMap(sortedEntries)

          val entryDetails = sortedEntries.map { e =>
            Json.obj(
              "ownerPubKeyHex" -> e.ownerHex.asJson,
              "receiverPubKeyHex" -> e.receiverHex.asJson,
              "totalDebtNanoErg" -> e.totalDebt.asJson,
              "keyHex" -> Base16.encode(e.key).asJson
            )
          }

          val trackerTreeErgoValue = trackerPlasmaMap.ergoValue
          val treeDigestHex = Base16.encode(trackerTreeErgoValue.getValue.digest.toArray)

          // Step 3: Encode registers
          val trackerPkConstant = GroupElementConstant(trackerPk)
          val r4Encoded = Base16.encode(ValueSerializer.serialize(trackerPkConstant))
          val r5Encoded = Base16.encode(ValueSerializer.serialize(AvlTreeConstant(trackerTreeErgoValue.getValue)))

          // Step 4: Get wallet address
          val (_, statusBody) = nodeGet("/wallet/status", apiKey)
          val changeAddr = parse(statusBody).getOrElse(Json.Null)
            .hcursor.downField("changeAddress").as[String].getOrElse("")
          if (changeAddr.isEmpty) throw new Exception("Wallet not available or locked")

          // Step 5: Build and submit transaction
          val generateRequest = Json.obj(
            "requests" -> Json.arr(Json.obj(
              "address" -> changeAddr.asJson,
              "value" -> 1000000L.asJson,
              "assets" -> Json.arr(Json.obj(
                "tokenId" -> trackerNftId.asJson,
                "amount" -> 1L.asJson
              )),
              "registers" -> Json.obj(
                "R4" -> r4Encoded.asJson,
                "R5" -> r5Encoded.asJson
              )
            )),
            "fee" -> 2000000L.asJson,
            "inputsRaw" -> Json.arr()
          )

          val (genCode, genBody) = nodePost("/wallet/transaction/generate", generateRequest.noSpaces, apiKey)

          if (genCode != 200) {
            Json.obj("error" -> s"Transaction generation failed ($genCode)".asJson, "detail" -> genBody.asJson)
          } else {
            val (submitCode, submitBody) = nodePost("/transactions", genBody, apiKey)

            if (submitCode != 200) {
              Json.obj("error" -> s"Transaction submission failed ($submitCode)".asJson, "detail" -> submitBody.asJson)
            } else {
              val txId = parse(submitBody).getOrElse(Json.fromString(submitBody))
                .asString.getOrElse(submitBody.replaceAll("\"", ""))
              val signedTx = parse(genBody).getOrElse(Json.Null)
              val trackerBoxId = signedTx.hcursor
                .downField("outputs").downArray
                .downField("boxId").as[String].getOrElse("")

              // Write tracker secret
              val secretDir = new java.io.File(System.getProperty("user.home"), ".chaincash-secrets")
              secretDir.mkdirs()
              val secretFile = new java.io.File(secretDir, s"tracker-${trackerNftId.take(8)}.json")
              val secretJson = Json.obj(
                "trackerNftId" -> trackerNftId.asJson,
                "trackerSecretHex" -> Base16.encode(trackerSecret.toByteArray).asJson,
                "trackerPubKeyHex" -> trackerPkHex.asJson,
                "trackerBoxId" -> trackerBoxId.asJson
              )
              val writer = new java.io.FileWriter(secretFile)
              writer.write(secretJson.spaces2)
              writer.close()

              Json.obj(
                "txId" -> txId.asJson,
                "trackerBoxId" -> trackerBoxId.asJson,
                "trackerPubKeyHex" -> trackerPkHex.asJson,
                "treeDigestHex" -> treeDigestHex.asJson,
                "entryCount" -> entries.size.asJson,
                "entries" -> entryDetails.asJson,
                "trackerNftId" -> trackerNftId.asJson,
                "status" -> "submitted".asJson,
                "secretFile" -> secretFile.getAbsolutePath.asJson
              )
            }
          }
        } catch {
          case e: Exception =>
            Json.obj("error" -> s"Tracker update failed: ${e.getMessage}".asJson)
        }
      }
    }
  })

  // ===== /reserve/redeem =====
  // Builds and submits a redemption transaction against the Basis reserve contract.
  // Loads all signing keys from ~/.chaincash-secrets/ — no secrets in the request.
  server.createContext("/reserve/redeem", (exchange: HttpExchange) => {
    handlePost(exchange) { body =>
      val cursor = body.hcursor
      val reserveBoxId = cursor.downField("reserveBoxId").as[String].getOrElse("")
      val trackerBoxId = cursor.downField("trackerBoxId").as[String].getOrElse("")
      val trackerNftId = cursor.downField("trackerNftId").as[String].getOrElse("")
      val ownerPubKeyHex = cursor.downField("ownerPubKeyHex").as[String].getOrElse("")
      val receiverPubKeyHex = cursor.downField("receiverPubKeyHex").as[String].getOrElse("")
      val totalDebt = cursor.downField("totalDebtNanoErg").as[Long].getOrElse(0L)
      val redeemAmount = cursor.downField("redeemAmountNanoErg").as[Long].getOrElse(0L)
      val apiKey = cursor.downField("nodeApiKey").as[String].getOrElse("")
      // Existing reserve tree entries from prior redemptions (needed for proof building)
      val existingEntries = cursor.downField("existingReserveEntries")
        .as[Vector[Json]].getOrElse(Vector.empty)
      // All tracker tree entries (for multi-entry tracker tree proof generation)
      // Each: { "ownerPubKeyHex": "...", "receiverPubKeyHex": "...", "totalDebtNanoErg": N }
      val trackerEntries = cursor.downField("trackerEntries")
        .as[Vector[Json]].getOrElse(Vector.empty)

      if (reserveBoxId.isEmpty || trackerBoxId.isEmpty || ownerPubKeyHex.isEmpty ||
          receiverPubKeyHex.isEmpty || totalDebt <= 0 || redeemAmount <= 0 || apiKey.isEmpty) {
        Json.obj("error" -> "Missing required fields".asJson)
      } else {
        try {
          // --- Step 1: Load secrets from ~/.chaincash-secrets/ ---
          val secretDir = new java.io.File(System.getProperty("user.home"), ".chaincash-secrets")

          def readSecretField(file: java.io.File, field: String): String = {
            val content = scala.io.Source.fromFile(file).mkString
            parse(content).getOrElse(Json.Null)
              .hcursor.downField(field).as[String]
              .getOrElse(throw new Exception(s"Missing '$field' in ${file.getName}"))
          }

          val ownerSecretHex = readSecretField(
            new java.io.File(secretDir, s"owner-${ownerPubKeyHex.take(8)}.json"), "secretHex")
          val trackerSecretHex = readSecretField(
            new java.io.File(secretDir, s"tracker-${trackerNftId.take(8)}.json"), "trackerSecretHex")
          val receiverSecretHex = readSecretField(
            new java.io.File(secretDir, s"receiver-${receiverPubKeyHex.take(8)}.json"), "secretHex")

          // --- Step 2: Decode pubkeys ---
          val ownerPkBytes = Base16.decode(ownerPubKeyHex).get
          val receiverPkBytes = Base16.decode(receiverPubKeyHex).get
          val ownerGE = GroupElementSerializer.fromBytes(ownerPkBytes)
          val receiverGE = GroupElementSerializer.fromBytes(receiverPkBytes)
          val trackerNftBytes = Base16.decode(trackerNftId).get

          // --- Step 3: Build Schnorr message: blake2b256(ownerPk || receiverPk) || longToByteArray(totalDebt) ---
          val key = Blake2b256(ownerPkBytes ++ receiverPkBytes)
          val message = key ++ Longs.toByteArray(totalDebt)

          // --- Step 4: Generate Schnorr signatures ---
          val ownerSecret = BigInt(ownerSecretHex, 16)
          val trackerSecret = BigInt(trackerSecretHex, 16)
          val receiverSecret = BigInt(receiverSecretHex, 16)

          val reserveSig = SigUtils.sign(message, ownerSecret)
          val trackerSig = SigUtils.sign(message, trackerSecret)
          val reserveSigBytes = GroupElementSerializer.toBytes(reserveSig._1) ++ reserveSig._2.toByteArray
          val trackerSigBytes = GroupElementSerializer.toBytes(trackerSig._1) ++ trackerSig._2.toByteArray

          // --- Step 5: Build tracker AVL tree lookup proof ---
          // Rebuild the tracker tree with ALL entries, sorted by key for deterministic structure
          val basisPlasmaParams = PlasmaParameters(32, None)
          val trackerMap = if (trackerEntries.nonEmpty) {
            val sortedTrackerEntries = parseAndSortTrackerEntries(trackerEntries)
            buildTrackerPlasmaMap(sortedTrackerEntries)
          } else {
            // Single-entry fallback (backward compatible)
            val m = new PlasmaMap[Array[Byte], Array[Byte]](AvlTreeFlags.InsertOnly, basisPlasmaParams)
            m.insert((key, Longs.toByteArray(totalDebt)))
            m
          }
          // Validate tracker tree digest matches on-chain
          // Use byTokenId endpoint (more reliably indexed than byId on private testnet)
          val trackerReconstructedDigest = Base16.encode(trackerMap.ergoValue.getValue.digest.toArray)
          val (_, tokenBoxBody) = nodeGet(s"/blockchain/box/byTokenId/$trackerNftId")
          val tokenBoxItems = parse(tokenBoxBody).getOrElse(Json.Null)
            .hcursor.downField("items").as[Vector[Json]].getOrElse(Vector.empty)
          val liveTrackerBox = tokenBoxItems.find(b =>
            b.hcursor.downField("boxId").as[String].getOrElse("") == trackerBoxId &&
            b.hcursor.downField("spentTransactionId").as[String].toOption.isEmpty
          )
          val onChainTrackerR5 = liveTrackerBox.flatMap(_.hcursor
            .downField("additionalRegisters").downField("R5")
            .as[String].toOption).getOrElse("")
          val onChainTrackerDigest = if (onChainTrackerR5.length > 8) onChainTrackerR5.drop(2).dropRight(6) else ""

          if (onChainTrackerDigest.nonEmpty && trackerReconstructedDigest != onChainTrackerDigest) {
            throw new Exception(
              s"Tracker tree digest mismatch! reconstructed=$trackerReconstructedDigest " +
              s"onChain=$onChainTrackerDigest. " +
              s"The trackerEntries do not reproduce the on-chain tracker tree."
            )
          }

          val trackerLookupProof = trackerMap.lookUp(key).proof.bytes

          // --- Step 6: Build reserve tree insertion proof ---
          // Must use InsertUpdate flags to match on-chain reserve R5 (flags=03)
          // Pre-load existing entries so the tree root matches the current on-chain state
          val reserveTreeFlags = AvlTreeFlags(insertAllowed = true, updateAllowed = true, removeAllowed = false)
          val reserveMap = new PlasmaMap[Array[Byte], Array[Byte]](reserveTreeFlags, basisPlasmaParams)
          for (entry <- existingEntries) {
            val eOwner = Base16.decode(entry.hcursor.downField("ownerPubKeyHex").as[String].getOrElse("")).get
            val eReceiver = Base16.decode(entry.hcursor.downField("receiverPubKeyHex").as[String].getOrElse("")).get
            val eAmount = entry.hcursor.downField("redeemedNanoErg").as[Long].getOrElse(0L)
            val eKey = Blake2b256(eOwner ++ eReceiver)
            reserveMap.insert((eKey, Longs.toByteArray(eAmount)))
          }
          // --- Step 6b: Validate reconstructed tree matches on-chain R5 ---
          // Fetch the current reserve box R5 digest from the chain and compare
          val reconstructedDigest = Base16.encode(reserveMap.ergoValue.getValue.digest.toArray)
          val (_, reserveBoxBody) = nodeGet(s"/utxo/byId/$reserveBoxId")
          val reserveBoxJson = parse(reserveBoxBody).getOrElse(Json.Null)

          // --- Step 6c: Verify reserve box is under the current contract version ---
          val onChainErgoTree = reserveBoxJson.hcursor.downField("ergoTree").as[String].getOrElse("")
          val expectedErgoTree = Base16.encode(basisErgoTree.bytes)
          if (onChainErgoTree.nonEmpty && onChainErgoTree != expectedErgoTree) {
            throw new Exception(
              s"Reserve box contract mismatch: on-chain ErgoTree does not match sidecar's compiled contract. " +
              s"The reserve may be deployed under an older contract version (v1 insert-only). " +
              s"Deploy a new reserve under the current contract for repeated same-pair redemption."
            )
          }
          val onChainR5Hex = reserveBoxJson.hcursor
            .downField("additionalRegisters").downField("R5")
            .as[String].getOrElse("")
          // R5 encoding: type tag (2 hex) + digest (variable) + flags (2 hex) + keyLength (4 hex)
          // Extract digest: skip type tag "64", take until flags+keyLength at end (6 hex chars)
          val onChainDigest = if (onChainR5Hex.length > 8) onChainR5Hex.drop(2).dropRight(6) else ""

          if (reconstructedDigest != onChainDigest) {
            throw new Exception(
              s"Reserve tree drift detected! Reconstructed digest does not match on-chain R5. " +
              s"reconstructed=$reconstructedDigest onChain=$onChainDigest " +
              s"This means settlement history is inconsistent with on-chain state. " +
              s"Cannot safely build insertion proof."
            )
          }

          // Check if this key already exists in the reserve tree (prior redemption for same pair)
          val keyExists = reserveMap.lookUp(key).response.head.tryOp.get.isDefined

          // Branch: insert (first redemption) or update (subsequent)
          val (treeProof, lookupProofOpt, updatedReserveTree) = if (keyExists) {
            // Key exists: generate lookup proof (for var #7) and update proof (for var #5)
            val lookupProof = reserveMap.lookUp(key).proof.bytes
            val existingRedeemed = Longs.fromByteArray(reserveMap.lookUp(key).response.head.tryOp.get.get)
            val newCumulative = existingRedeemed + redeemAmount
            val updateRes = reserveMap.update((key, Longs.toByteArray(newCumulative)))
            (updateRes.proof.bytes, Some(lookupProof), reserveMap.ergoValue)
          } else {
            // Key does not exist: generate insert proof only (no var #7)
            val insertRes = reserveMap.insert((key, Longs.toByteArray(redeemAmount)))
            (insertRes.proof.bytes, None, reserveMap.ergoValue)
          }

          // --- Step 7: Derive receiver P2PK address ---
          val receiverProveDlog = sigmastate.basics.DLogProtocol.ProveDlog(receiverGE)
          val receiverAddr = org.ergoplatform.P2PKAddress(receiverProveDlog)(ergoAddressEncoder)

          // --- Step 8: Build and sign transaction via AppKit ---
          val feeAmount = 1100000L

          // Create node-only data source (no explorer needed for private testnet)
          val nodeApiClient = new org.ergoplatform.restapi.client.ApiClient(nodeUrl, "ApiKeyAuth", apiKey)
          val dataSource = new org.ergoplatform.appkit.impl.NodeDataSourceImpl(nodeApiClient)
          val ctx = new org.ergoplatform.appkit.impl.BlockchainContextBuilderImpl(dataSource, networkType).build()

          val result: (String, Long, Long) = {
                // Fetch boxes from blockchain
                val reserveBox = ctx.getBoxesById(reserveBoxId)(0)
                val trackerBox = ctx.getBoxesById(trackerBoxId)(0)

                val reserveValueBefore = reserveBox.getValue

                // Attach context extension to reserve input
                val baseVars = Array(
                  new org.ergoplatform.appkit.ContextVar(0.toByte, org.ergoplatform.appkit.ErgoValue.of(0: Byte)),
                  new org.ergoplatform.appkit.ContextVar(1.toByte, org.ergoplatform.appkit.ErgoValue.of(receiverGE)),
                  new org.ergoplatform.appkit.ContextVar(2.toByte, org.ergoplatform.appkit.ErgoValue.of(reserveSigBytes)),
                  new org.ergoplatform.appkit.ContextVar(3.toByte, org.ergoplatform.appkit.ErgoValue.of(totalDebt)),
                  new org.ergoplatform.appkit.ContextVar(5.toByte, org.ergoplatform.appkit.ErgoValue.of(treeProof)),
                  new org.ergoplatform.appkit.ContextVar(6.toByte, org.ergoplatform.appkit.ErgoValue.of(trackerSigBytes)),
                  new org.ergoplatform.appkit.ContextVar(8.toByte, org.ergoplatform.appkit.ErgoValue.of(trackerLookupProof))
                )
                // Include var #7 (reserve tree lookup proof) only for update path
                val allVars = lookupProofOpt match {
                  case Some(lp) => baseVars :+ new org.ergoplatform.appkit.ContextVar(7.toByte, org.ergoplatform.appkit.ErgoValue.of(lp))
                  case None => baseVars
                }
                val reserveInput = reserveBox.withContextVars(allVars: _*)

                val txBuilder = ctx.newTxBuilder()

                // Build reserve output (value reduced by redeemAmount)
                val reserveContract = ctx.compileContract(
                  org.ergoplatform.appkit.ConstantsBuilder.empty(), basisContractScript
                )
                val reserveValueAfter = reserveValueBefore - redeemAmount
                val reserveOutput = txBuilder.outBoxBuilder()
                  .value(reserveValueAfter)
                  .contract(reserveContract)
                  .tokens(reserveBox.getTokens.get(0))
                  .registers(
                    org.ergoplatform.appkit.ErgoValue.of(ownerGE),
                    updatedReserveTree,
                    org.ergoplatform.appkit.ErgoValue.of(trackerNftBytes)
                  )
                  .build()

                // Build payout output (redeemAmount minus fee)
                val payoutValue = redeemAmount - feeAmount
                val receiverAppkitAddr = org.ergoplatform.appkit.Address.create(receiverAddr.toString)
                val payoutOutput = txBuilder.outBoxBuilder()
                  .value(payoutValue)
                  .contract(receiverAppkitAddr.toErgoContract())
                  .build()

                // Build unsigned transaction
                val unsignedTx = txBuilder
                  .boxesToSpend(java.util.Arrays.asList(reserveInput))
                  .withDataInputs(java.util.Arrays.asList(trackerBox))
                  .outputs(reserveOutput, payoutOutput)
                  .fee(feeAmount)
                  .sendChangeTo(receiverAppkitAddr.getErgoAddress)
                  .build()

                // Sign with receiver's dlog secret (satisfies proveDlog(receiver) in contract)
                val prover = ctx.newProverBuilder()
                  .withDLogSecret(receiverSecret.bigInteger)
                  .build()
                val signedTx = prover.sign(unsignedTx)

                // Submit
                val txId = ctx.sendTransaction(signedTx)

                (txId, reserveValueBefore, reserveValueAfter)
          }

          val (txId, reserveValueBefore, reserveValueAfter) = result

          Json.obj(
            "txId" -> txId.asJson,
            "status" -> "submitted".asJson,
            "redeemAmountNanoErg" -> redeemAmount.asJson,
            "payoutNanoErg" -> (redeemAmount - feeAmount).asJson,
            "feeNanoErg" -> feeAmount.asJson,
            "reserveValueBefore" -> reserveValueBefore.asJson,
            "reserveValueAfter" -> reserveValueAfter.asJson,
            "receiverAddress" -> receiverAddr.toString.asJson,
            "debtKeyHex" -> Base16.encode(key).asJson,
            "r5DigestAfter" -> Base16.encode(updatedReserveTree.getValue.digest.toArray).asJson,
            "note" -> "Redemption transaction submitted. Full 0.1 ERG debt redeemed.".asJson
          )
        } catch {
          case e: Exception =>
            val sw = new java.io.StringWriter()
            e.printStackTrace(new java.io.PrintWriter(sw))
            Json.obj(
              "error" -> s"Redemption failed: ${e.getMessage}".asJson,
              "stackTrace" -> sw.toString.take(2000).asJson
            )
        }
      }
    }
  })

  server.setExecutor(null)
  server.start()
  println(s"Sidecar running on http://localhost:$port")
  println("Endpoints: /health, /network/height, /wallet/pubkey, /nft/mint, /reserve/deploy, /reserve/build-and-submit, /reserve/scan, /reserve/status, /tracker/deploy, /reserve/redeem")

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
