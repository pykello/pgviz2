package net.moshayedi.dsserver.pg

import cats.Applicative
import cats.implicits._
import io.circe.{Encoder, Json}
import org.http4s.EntityEncoder
import org.http4s.circe._

trait PostgresREST[F[_]]{
  def heapPageResponse(request: PostgresREST.HeapPageRequest): F[PostgresREST.HeapPageResponse]
}

object PostgresREST {
  implicit def apply[F[_]](implicit ev: PostgresREST[F]): PostgresREST[F] = ev

  final case class HeapPageRequest(relation: String, page: Int)
  final case class HeapPageResponse(relation: String, page: Int)

  object HeapPageResponse {
    implicit val heapPageResponseEncoder: Encoder[HeapPageResponse] = new Encoder[HeapPageResponse] {
      final def apply(a: HeapPageResponse): Json = Json.obj(
        ("relation", Json.fromString(a.relation)),
        ("page", Json.fromInt(a.page))
      )
    }
    implicit def heapPageResponseEntityEncoder[F[_]]: EntityEncoder[F, HeapPageResponse] =
      jsonEncoderOf[F, HeapPageResponse]
  }

  def impl[F[_]: Applicative]: PostgresREST[F] = new PostgresREST[F]{
    def heapPageResponse(request: PostgresREST.HeapPageRequest): F[PostgresREST.HeapPageResponse] =
        HeapPageResponse(request.relation, request.page).pure[F]
  }
}
