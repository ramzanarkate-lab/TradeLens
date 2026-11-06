package com.tradelens.app.core.network

import kotlinx.coroutines.CancellationException
import retrofit2.HttpException
import java.io.IOException

suspend fun <T> safeApiCall(block: suspend () -> T): AppResult<T> =
    try {
        AppResult.Success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: HttpException) {
        AppResult.Error(AppError.Http(e.code(), runCatching { e.response()?.errorBody()?.string() }.getOrNull()))
    } catch (e: IOException) {
        AppResult.Error(AppError.Network)
    } catch (e: Exception) {
        AppResult.Error(AppError.Unknown(e))
    }
