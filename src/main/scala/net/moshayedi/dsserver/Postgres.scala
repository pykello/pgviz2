package net.moshayedi.dsserver

import cats.Applicative
import cats.implicits._
import io.circe.{Encoder, Json}
import org.http4s.EntityEncoder
import org.http4s.circe._

trait Postgres[F[_]]{
  def heapPageContents(n: Postgres.HeapPage): F[Postgres.HeapPageContents]
}

object Postgres {
  implicit def apply[F[_]](implicit ev: Postgres[F]): Postgres[F] = ev

  final case class HeapPage(relation: String, page: Int)

  /**
    * More generally you will want to decouple your edge representations from
    * your internal data structures, however this shows how you can
    * create encoders for your data.
    **/
  final case class HeapPageContents(relation: String, page: Int)

  object HeapPageContents {
    implicit val heapPageContentEncoder: Encoder[HeapPageContents] = new Encoder[HeapPageContents] {
      final def apply(a: HeapPageContents): Json = Json.obj(
        ("relation", Json.fromString(a.relation)),
        ("page", Json.fromInt(a.page))
      )
    }
    implicit def greetingEntityEncoder[F[_]]: EntityEncoder[F, HeapPageContents] =
      jsonEncoderOf[F, HeapPageContents]
  }

  def impl[F[_]: Applicative]: Postgres[F] = new Postgres[F]{
    def heapPageContents(n: Postgres.HeapPage): F[Postgres.HeapPageContents] =
        HeapPageContents(n.relation, n.page).pure[F]
  }
}
