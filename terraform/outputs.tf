output "url" {
  description = "URL of the deployed app"
  value       = aws_apigatewayv2_stage.default.invoke_url
}
