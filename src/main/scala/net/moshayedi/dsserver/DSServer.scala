package net.moshayedi.dsserver

import cats.effect.{Async, Resource, Sync}
import cats.syntax.all._
import com.comcast.ip4s._
import fs2.Stream
import net.moshayedi.dsserver.pg.PostgresREST
import org.http4s.HttpRoutes
import org.http4s.ember.client.EmberClientBuilder
import org.http4s.ember.server.EmberServerBuilder
import org.http4s.implicits._
import org.http4s.server.Router
import org.http4s.server.middleware.Logger

object DSServer {

  def routes[F[_]: Sync](): HttpRoutes[F] =
    Router[F](
      "/pg" -> PostgresREST.routes(),
    )

  def stream[F[_]: Async]: Stream[F, Nothing] = {
    for {
      _ <- Stream.resource(EmberClientBuilder.default[F].build)

      // Combine Service Routes into an HttpApp.
      // Can also be done via a Router if you
      // want to extract a segments not checked
      // in the underlying routes.
      httpApp = (
        routes()
      ).orNotFound

      // With Middlewares in place
      finalHttpApp = Logger.httpApp(true, true)(httpApp)

      exitCode <- Stream.resource(
        EmberServerBuilder.default[F]
          .withHost(ipv4"0.0.0.0")
          .withPort(port"8080")
          .withHttpApp(finalHttpApp)
          .build >>
        Resource.eval(Async[F].never)
      )
    } yield exitCode
  }.drain
}
