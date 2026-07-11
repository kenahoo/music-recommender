output "url" {
  description = "URL of the deployed app"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "function_url" {
  description = "Direct Lambda Function URL (no 30s API Gateway timeout cap)"
  value       = aws_lambda_function_url.app.function_url
}
