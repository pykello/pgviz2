package net.moshayedi.dsserver.pg

import cats.effect.Sync
import org.http4s.HttpRoutes
import org.http4s.dsl.Http4sDsl
import io.circe.syntax._
import io.circe.generic.auto._
import org.http4s.circe.jsonEncoder

object PostgresREST {
  def routes[F[_]: Sync](): HttpRoutes[F] = {
    val dsl = new Http4sDsl[F]{}
    import dsl._

    HttpRoutes.of[F] {
      case GET -> Root / "heap" / relation / IntVar(page) =>
        val result = HeapPage(relation, page, Seq(1,2,3).toArray).asJson
        Ok(result)
    }
  }
}
