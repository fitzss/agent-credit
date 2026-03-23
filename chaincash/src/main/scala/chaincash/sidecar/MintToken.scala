package chaincash.sidecar

import org.ergoplatform.appkit._
import org.ergoplatform.appkit.impl.{BlockchainContextBuilderImpl, NodeDataSourceImpl}
import org.ergoplatform.restapi.client.ApiClient
import collection.JavaConverters._
import io.circe.parser._
import io.circe.syntax._
import io.circe.Json

/**
 * Mint a singleton token using AppKit + wallet signing.
 */
object MintToken extends App {
  val nodeUrl = sys.env.getOrElse("ERGO_NODE_URL", "http://localhost:9052")
  val apiKey = sys.env.getOrElse("ERGO_NODE_API_KEY", "hello")
  val networkType = NetworkType.TESTNET

  val nodeApiClient = new ApiClient(nodeUrl, "ApiKeyAuth", apiKey)
  val dataSource = new NodeDataSourceImpl(nodeApiClient)
  val ctx = new BlockchainContextBuilderImpl(dataSource, networkType).build()

  // Get wallet address
  val walletResp = scalaj.http.Http(s"$nodeUrl/wallet/status")
    .header("api_key", apiKey).timeout(30000, 30000).asString
  val changeAddr = parse(walletResp.body).getOrElse(Json.Null)
    .hcursor.downField("changeAddress").as[String].getOrElse("")
  println(s"Wallet: $changeAddr")

  // Get first unspent box
  val boxesResp = scalaj.http.Http(s"$nodeUrl/wallet/boxes/unspent?minConfirmations=1&minInclusionHeight=0&maxBoxes=1")
    .header("api_key", apiKey).timeout(60000, 60000).asString
  val firstBoxId = parse(boxesResp.body).getOrElse(Json.Null)
    .asArray.getOrElse(Vector.empty).headOption
    .flatMap(_.hcursor.downField("box").downField("boxId").as[String].toOption)
    .getOrElse(throw new Exception("No wallet boxes"))
  println(s"First box (token ID): $firstBoxId")

  val inputBox = ctx.getBoxesById(firstBoxId)(0)

  // Build mint transaction using AppKit
  val txBuilder = ctx.newTxBuilder()
  val mintOutput = txBuilder.outBoxBuilder()
    .value(1000000L)
    .mintToken(new Eip4Token(inputBox.getId.toString, 1L, "Reserve V2", "Singleton", 0))
    .contract(Address.create(changeAddr).toErgoContract())
    .build()

  val unsignedTx = txBuilder
    .boxesToSpend(java.util.Arrays.asList(inputBox))
    .outputs(mintOutput)
    .fee(2000000L)
    .sendChangeTo(Address.create(changeAddr).getErgoAddress)
    .build()

  // Convert to JSON and fix format for wallet signing endpoint
  val txJson = parse(unsignedTx.toJson(false)).getOrElse(Json.Null)
  // Add empty "extension" to each input if missing
  val inputs = txJson.hcursor.downField("inputs").as[Vector[Json]].getOrElse(Vector.empty)
  val fixedInputs = inputs.map { inp =>
    if (inp.hcursor.downField("extension").succeeded) inp
    else inp.deepMerge(Json.obj("extension" -> Json.obj()))
  }
  val fixedTx = txJson.deepMerge(Json.obj("inputs" -> fixedInputs.asJson))
  val signPayload = Json.obj("tx" -> fixedTx)

  val signResp = scalaj.http.Http(s"$nodeUrl/wallet/transaction/sign")
    .header("api_key", apiKey)
    .header("Content-Type", "application/json")
    .timeout(60000, 60000)
    .postData(signPayload.noSpaces)
    .asString

  if (signResp.code != 200) {
    println(s"Sign failed (${signResp.code}): ${signResp.body.take(300)}")
    System.exit(1)
  }

  // Submit
  val submitResp = scalaj.http.Http(s"$nodeUrl/transactions")
    .header("Content-Type", "application/json")
    .timeout(30000, 30000)
    .postData(signResp.body)
    .asString

  if (submitResp.code != 200) {
    println(s"Submit failed (${submitResp.code}): ${submitResp.body.take(300)}")
    System.exit(1)
  }

  println(s"Minted! TX: ${submitResp.body.replaceAll("\"", "")}")
  println(s"Token ID: ${inputBox.getId}")
}
