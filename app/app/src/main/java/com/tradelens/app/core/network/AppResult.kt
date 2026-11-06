package com.tradelens.app.core.network

import com.squareup.moshi.JsonClass
import com.squareup.moshi.Moshi

sealed interface AppResult<out T> {
    data class Success<T>(val data: T) : AppResult<T>
    data class Error(val error: AppError) : AppResult<Nothing>
    data object Loading : AppResult<Nothing>
}

/** Mapped failure causes. The UI turns these into localized messages. */
sealed interface AppError {
    data object Network : AppError
    data class Http(val code: Int, val body: String?) : AppError
    data class Unknown(val cause: Throwable?) : AppError
}

@JsonClass(generateAdapter = true)
internal data class ErrorBody(val error: ErrorDetail?)

@JsonClass(generateAdapter = true)
internal data class ErrorDetail(val code: String?, val message: String?)

private val errorAdapter = Moshi.Builder().build().adapter(ErrorBody::class.java)

/** The server's `{ error: { code, message } }` message, when the response had one. */
fun AppError.Http.serverMessage(): String? =
    runCatching { errorAdapter.fromJson(body ?: return null)?.error?.message }.getOrNull()
