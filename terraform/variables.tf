variable "app_password" {
  description = "Password to access the web UI"
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key"
  sensitive   = true
}

variable "github_token" {
  description = "GitHub personal access token with Contents read/write"
  sensitive   = true
}

variable "github_repo" {
  description = "GitHub repo in owner/name format"
}

variable "aws_region" {
  description = "AWS region to deploy to"
  default     = "us-east-1"
}

variable "function_name" {
  description = "Name for the Lambda function and related resources"
  default     = "music-recommend"
}
