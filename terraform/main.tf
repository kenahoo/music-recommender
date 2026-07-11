terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ── IAM ────────────────────────────────────────────────────────────────────────

resource "aws_iam_role" "lambda" {
  name = "${var.function_name}-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ── Package ────────────────────────────────────────────────────────────────────

# Run npm install whenever package.json changes
resource "null_resource" "npm_install" {
  triggers = {
    package_json = filemd5("${path.module}/../lambda/package.json")
  }
  provisioner "local-exec" {
    command     = "npm install --production --silent"
    working_dir = "${path.module}/../lambda"
  }
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda"
  output_path = "${path.module}/function.zip"
  excludes    = [".DS_Store"]
  depends_on  = [null_resource.npm_install]
}

# ── Lambda ─────────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "app" {
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  function_name    = var.function_name
  role             = aws_iam_role.lambda.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 120
  memory_size      = 256

  environment {
    variables = {
      APP_PASSWORD      = var.app_password
      ANTHROPIC_API_KEY = var.anthropic_api_key
      GITHUB_TOKEN      = var.github_token
      GITHUB_REPO       = var.github_repo
    }
  }
}

# ── Function URL ─────────────────────────────────────────────────────────────
# Direct Lambda endpoint. Unlike the API Gateway HTTP API (hard 30s integration
# timeout), a Function URL honors the Lambda's own timeout, so long chat/commit
# requests no longer get cut off with a 503.

resource "aws_lambda_function_url" "app" {
  function_name      = aws_lambda_function.app.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "function_url" {
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.app.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# As of October 2025, public function URLs also require lambda:InvokeFunction in
# addition to lambda:InvokeFunctionUrl, or every request 403s. Ideally this would be
# scoped with the lambda:InvokedViaFunctionUrl condition, but aws_lambda_permission
# can't express that condition, so this grants InvokeFunction to all principals.
resource "aws_lambda_permission" "function_invoke" {
  statement_id  = "FunctionURLInvokeAllowPublicAccess"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app.function_name
  principal     = "*"
}

# ── API Gateway ────────────────────────────────────────────────────────────────

resource "aws_apigatewayv2_api" "app" {
  name          = var.function_name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.app.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.app.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.app.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "apigw-invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.app.execution_arn}/*"
}
