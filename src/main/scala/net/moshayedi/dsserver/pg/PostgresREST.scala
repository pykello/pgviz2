package net.moshayedi.dsserver.pg

import cats.effect.Sync
import org.http4s.HttpRoutes
import org.http4s.dsl.Http4sDsl

object PostgresREST {
  def routes[F[_]: Sync](): HttpRoutes[F] = {
    val dsl = new Http4sDsl[F]{}
    import dsl._

    HttpRoutes.of[F] {
      case GET -> Root / "heap" / relation / IntVar(page) =>
        Ok(s"heap page, relation=$relation, page=$page")
    }
  }
}
