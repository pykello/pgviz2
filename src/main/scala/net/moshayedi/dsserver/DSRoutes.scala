package net.moshayedi.dsserver

import cats.effect.Sync
import cats.implicits._
import org.http4s.HttpRoutes
import org.http4s.dsl.Http4sDsl

object DSRoutes {

  def postgresRoutes[F[_]: Sync](H: Postgres[F]): HttpRoutes[F] = {
    val dsl = new Http4sDsl[F]{}
    import dsl._
    HttpRoutes.of[F] {
      case GET -> Root / "pg" / "heap" / relation / IntVar(page) =>
        for {
          greeting <- H.heapPageContents(Postgres.HeapPage(relation, page))
          resp <- Ok(greeting)
        } yield resp
    }
  }
}